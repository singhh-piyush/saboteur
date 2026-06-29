"""Acceptance tests for the FastAPI routes (LLM-free via FakeAgent injection).

Coverage:
  1. OpenAPI schema renders.
  2. GET /profiles — all bundled profiles listed with required fields.
  3. POST /runs lifecycle — starts, transitions to finished, scorecard readable.
  4. Unknown profile → 404.  Scorecard before finish → 425.
  5. GET /runs/{id}/events — pagination and after_ts filter.
  6. POST /replay — WS client receives all replayed events.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from saboteur.agents.outcomes import AgentRunResult, Outcome
from saboteur.telemetry.schema import TelemetryEvent

# ---------------------------------------------------------------------------
# FakeAgent — same interface as SaboteurAgent (duck-typed)
# ---------------------------------------------------------------------------


def _result(agent_id: int) -> AgentRunResult:
    return AgentRunResult(
        agent_id=agent_id,
        outcome=Outcome.COMPLETED,
        task_result=None,
        tokens_used=100,
        steps_taken=3,
    )


class _FakeAgent:
    def __init__(self, agent_id: int, on_event, *, result: AgentRunResult | None = None):
        self.agent_id = agent_id
        self.on_event = on_event
        self.result = result or _result(agent_id)

    async def run(self) -> AgentRunResult:
        return self.result


def _fake_factory(agent_id, profile, store, on_event, oracle=None):
    return _FakeAgent(agent_id, on_event)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_runs(tmp_path: Path, monkeypatch):
    """Redirect all JSONL/scorecard writes — and the SQLite index — to tmp."""
    import saboteur.api.runs as runs_mod
    import saboteur.api.replay as replay_mod
    import saboteur.telemetry.ws as ws_mod
    from saboteur.storage.db import db as index_db

    monkeypatch.setattr(runs_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(replay_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(ws_mod, "_RUNS_DIR", tmp_path)
    # Point the shared index singleton at a temp DB (mutated in place so every
    # holder of the singleton — runs_mod._db, target_store — follows along).
    monkeypatch.setattr(index_db, "path", tmp_path / "saboteur.db")
    index_db.init()
    return tmp_path


@pytest.fixture()
def clean_registry(monkeypatch):
    """Fresh RunRegistry isolated from other tests."""
    from saboteur.api.state import RunRegistry
    import saboteur.api.state as state_mod
    import saboteur.api.runs as runs_mod

    fresh = RunRegistry()
    monkeypatch.setattr(state_mod, "run_registry", fresh)
    monkeypatch.setattr(runs_mod, "run_registry", fresh)
    return fresh


@pytest.fixture()
def fake_factory(monkeypatch):
    """Swap the LLM-backed agent factory for a FakeAgent."""
    import saboteur.api.runs as runs_mod

    monkeypatch.setattr(runs_mod, "_agent_factory", _fake_factory)


# ---------------------------------------------------------------------------
# 1. OpenAPI / health
# ---------------------------------------------------------------------------


def test_openapi_renders():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/openapi.json")
    assert resp.status_code == 200
    assert "paths" in resp.json()


def test_health():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# 2. GET /profiles
# ---------------------------------------------------------------------------


def test_list_profiles_returns_all_profiles():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/profiles")
    assert resp.status_code == 200
    names = {p["name"] for p in resp.json()}
    assert names == {
        "calm_seas",
        "flaky_friday",
        "hell_mode",
        "rate_limit_storm",
        "liars_den",
    }


def test_list_profiles_have_required_fields():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/profiles")
    for profile in resp.json():
        assert "name" in profile
        assert "description" in profile
        assert "seed" in profile
        assert "faults" in profile


# ---------------------------------------------------------------------------
# 3. POST /runs lifecycle
# ---------------------------------------------------------------------------


def test_run_lifecycle_and_scorecard(tmp_runs, clean_registry, fake_factory):
    """POST /runs → poll until finished → GET scorecard."""
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post(
            "/runs",
            json={"profile": "calm_seas", "n_agents": 2, "with_control": False},
        )
        assert resp.status_code == 202
        run_id = resp.json()["run_id"]

        # FakeAgent is instant; poll up to 2 s.
        for _ in range(20):
            status_resp = client.get(f"/runs/{run_id}")
            assert status_resp.status_code == 200
            if status_resp.json()["status"] == "finished":
                break
            time.sleep(0.1)

        data = status_resp.json()
        assert data["status"] == "finished", f"never finished: {data}"
        assert data["profile"] == "calm_seas"
        assert data["n_agents"] == 2
        assert data["error"] is None

        sc_resp = client.get(f"/runs/{run_id}/scorecard")
        assert sc_resp.status_code == 200
        sc = sc_resp.json()
        assert "survival_rate" in sc
        assert sc["n_agents"] == 2
        assert sc["run_id"] == run_id


def test_run_unknown_profile_returns_404(tmp_runs, clean_registry, fake_factory):
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/runs", json={"profile": "no_such_profile", "with_control": False})
    assert resp.status_code == 404


def test_run_status_unknown_run_returns_404():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/runs/totally-nonexistent-run-id")
    assert resp.status_code == 404


def test_scorecard_not_ready_returns_425(clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    clean_registry.add(
        RunState(
            run_id="pending-run-test",
            profile="calm_seas",
            n_agents=1,
            with_control=False,
            status=RunStatus.PENDING,
        )
    )

    with TestClient(app) as client:
        resp = client.get("/runs/pending-run-test/scorecard")
    assert resp.status_code == 425


# ---------------------------------------------------------------------------
# 3b. GET /runs (index)
# ---------------------------------------------------------------------------


def test_list_runs_merges_registry_and_disk(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    clean_registry.add(
        RunState(run_id="live-run-001", profile="hell_mode", n_agents=4,
                 with_control=True, status=RunStatus.RUNNING)
    )
    # A finished run from a previous server life: JSONL + scorecard on disk.
    (tmp_runs / "flaky_friday-20260101T000000-aaaaaa.jsonl").write_text("")
    (tmp_runs / "flaky_friday-20260101T000000-aaaaaa.scorecard.json").write_text(
        '{"profile": "flaky_friday"}'
    )
    # Control logs are folded into their parent run, never listed.
    (tmp_runs / "flaky_friday-20260101T000000-aaaaaa-control.jsonl").write_text("")

    with TestClient(app) as client:
        resp = client.get("/runs")
    assert resp.status_code == 200
    by_id = {r["run_id"]: r for r in resp.json()}

    assert by_id["live-run-001"]["status"] == "running"
    assert by_id["live-run-001"]["has_scorecard"] is False

    archived = by_id["flaky_friday-20260101T000000-aaaaaa"]
    assert archived["status"] == "archived"
    assert archived["profile"] == "flaky_friday"
    assert archived["has_scorecard"] is True

    assert "flaky_friday-20260101T000000-aaaaaa-control" not in by_id


# ---------------------------------------------------------------------------
# 4. GET /runs/{id}/events
# ---------------------------------------------------------------------------


def _write_events(path: Path, run_id: str, n: int, base_ts: datetime) -> list[TelemetryEvent]:
    events = [
        TelemetryEvent(
            run_id=run_id,
            agent_id=0,
            step=i,
            event="step_start",
            ts=base_ts + timedelta(seconds=i),
        )
        for i in range(n)
    ]
    with path.open("w", encoding="utf-8") as f:
        for e in events:
            f.write(e.model_dump_json() + "\n")
    return events


def test_events_returns_all(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "events-test-001"
    clean_registry.add(
        RunState(run_id=run_id, profile="calm_seas", n_agents=1, with_control=False,
                 status=RunStatus.FINISHED)
    )
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _write_events(tmp_runs / f"{run_id}.jsonl", run_id, 5, base)

    with TestClient(app) as client:
        resp = client.get(f"/runs/{run_id}/events")
    assert resp.status_code == 200
    assert len(resp.json()) == 5


def test_events_after_ts_filter(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "events-test-002"
    clean_registry.add(
        RunState(run_id=run_id, profile="calm_seas", n_agents=1, with_control=False,
                 status=RunStatus.FINISHED)
    )
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = _write_events(tmp_runs / f"{run_id}.jsonl", run_id, 5, base)

    # after_ts == events[1].ts excludes steps 0 and 1; keeps 2, 3, 4.
    cutoff = events[1].ts.isoformat()
    with TestClient(app) as client:
        resp = client.get(f"/runs/{run_id}/events", params={"after_ts": cutoff})
    assert resp.status_code == 200
    steps = [e["step"] for e in resp.json()]
    assert steps == [2, 3, 4]


def test_events_limit(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "events-test-003"
    clean_registry.add(
        RunState(run_id=run_id, profile="calm_seas", n_agents=1, with_control=False,
                 status=RunStatus.FINISHED)
    )
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    _write_events(tmp_runs / f"{run_id}.jsonl", run_id, 10, base)

    with TestClient(app) as client:
        resp = client.get(f"/runs/{run_id}/events", params={"limit": 3})
    assert resp.status_code == 200
    assert len(resp.json()) == 3


def test_events_no_jsonl_returns_empty(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "events-test-004"
    clean_registry.add(
        RunState(run_id=run_id, profile="calm_seas", n_agents=1, with_control=False,
                 status=RunStatus.RUNNING)
    )

    with TestClient(app) as client:
        resp = client.get(f"/runs/{run_id}/events")
    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# 4b. Archived runs survive a server restart (empty registry, disk intact)
# ---------------------------------------------------------------------------


def test_archived_run_events_and_scorecard_served_from_disk(tmp_runs, clean_registry):
    """After a backend restart the registry is empty, but events + scorecard
    must still be served from runs/ so replay keeps working."""
    from saboteur.api import app

    run_id = "flaky_friday-20260102T000000-bbbbbb"
    base = datetime(2026, 1, 2, tzinfo=timezone.utc)
    _write_events(tmp_runs / f"{run_id}.jsonl", run_id, 4, base)
    (tmp_runs / f"{run_id}.scorecard.json").write_text(
        '{"run_id": "%s", "profile": "flaky_friday", "n_agents": 2,'
        ' "survival_rate": 1.0, "mttr_steps": null, "recovery_breakdown": {},'
        ' "waste_factor": 1.0, "deception_detection_rate": null,'
        ' "failure_modes": {}, "control_run_id": null, "per_agent": {}}' % run_id
    )

    with TestClient(app) as client:
        events = client.get(f"/runs/{run_id}/events")
        scorecard = client.get(f"/runs/{run_id}/scorecard")
        status = client.get(f"/runs/{run_id}")

    assert events.status_code == 200
    assert len(events.json()) == 4
    assert scorecard.status_code == 200
    assert scorecard.json()["profile"] == "flaky_friday"
    assert status.status_code == 200
    assert status.json()["status"] == "finished"


# ---------------------------------------------------------------------------
# 5. POST /replay + WS
# ---------------------------------------------------------------------------


def test_replay_ws_receives_events(tmp_runs):
    """POST /replay with speed=0 → connect WS → receive all events via backlog."""
    from saboteur.api import app

    source_run = "replay-source-001"
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = [
        TelemetryEvent(
            run_id=source_run,
            agent_id=0,
            step=i,
            event="step_start",
            ts=base + timedelta(seconds=i),
        )
        for i in range(3)
    ]
    log = tmp_runs / f"{source_run}.jsonl"
    with log.open("w") as f:
        for e in events:
            f.write(e.model_dump_json() + "\n")

    with TestClient(app) as client:
        resp = client.post("/replay", json={"jsonl_path": str(log), "speed": 0})
        assert resp.status_code == 202
        run_id = resp.json()["run_id"]

        # Give the background stream task time to emit and close the bus.
        time.sleep(0.5)

        # By now the replay is done and the JSONL has been written.
        # The WS endpoint will replay the backlog.
        with client.websocket_connect(f"/ws/{run_id}") as ws:
            received = []
            for _ in range(3):
                received.append(ws.receive_json())

    assert len(received) == 3
    assert {r["step"] for r in received} == {0, 1, 2}


def test_replay_nonexistent_file_returns_404():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/replay", json={"jsonl_path": "/no/such/file.jsonl"})
    assert resp.status_code == 404


def test_replay_non_jsonl_returns_422():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/replay", json={"jsonl_path": "somefile.txt"})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 6. DELETE /runs — single and bulk
# ---------------------------------------------------------------------------


def test_delete_running_run_returns_409(tmp_runs, clean_registry):
    """DELETE a RUNNING run must return 409 — never touch active run files."""
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "del-running-test"
    clean_registry.add(
        RunState(
            run_id=run_id,
            profile="calm_seas",
            n_agents=2,
            with_control=False,
            status=RunStatus.RUNNING,
        )
    )
    # Write a JSONL so it exists on disk — must NOT be deleted.
    (tmp_runs / f"{run_id}.jsonl").write_text('{"run_id":"x"}\n')

    with TestClient(app) as client:
        resp = client.delete(f"/runs/{run_id}")

    assert resp.status_code == 409
    assert (tmp_runs / f"{run_id}.jsonl").exists(), "JSONL must survive a 409 refusal"


def test_delete_finished_run_removes_files(tmp_runs, clean_registry):
    """DELETE a finished run removes JSONL and scorecard from disk."""
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    run_id = "del-finished-test"
    clean_registry.add(
        RunState(
            run_id=run_id,
            profile="calm_seas",
            n_agents=1,
            with_control=False,
            status=RunStatus.FINISHED,
        )
    )
    jsonl = tmp_runs / f"{run_id}.jsonl"
    scorecard = tmp_runs / f"{run_id}.scorecard.json"
    jsonl.write_text('{"run_id":"x"}\n')
    scorecard.write_text('{"run_id":"del-finished-test"}')

    with TestClient(app) as client:
        resp = client.delete(f"/runs/{run_id}")

    assert resp.status_code == 204
    assert not jsonl.exists(), "JSONL should have been deleted"
    assert not scorecard.exists(), "scorecard should have been deleted"


def test_bulk_delete_skips_running_runs(tmp_runs, clean_registry):
    """DELETE /runs?status=finished removes finished runs but leaves running ones."""
    from saboteur.api import app
    from saboteur.api.state import RunState, RunStatus

    # One RUNNING run — must survive.
    running_id = "bulk-running"
    clean_registry.add(
        RunState(
            run_id=running_id,
            profile="calm_seas",
            n_agents=2,
            with_control=False,
            status=RunStatus.RUNNING,
        )
    )
    (tmp_runs / f"{running_id}.jsonl").write_text('{"run_id":"x"}\n')

    # Two finished runs (no registry entry = archived).
    for i in range(2):
        rid = f"bulk-finished-{i}"
        (tmp_runs / f"{rid}.jsonl").write_text('{"run_id":"x"}\n')
        (tmp_runs / f"{rid}.scorecard.json").write_text('{"run_id":"x"}')

    with TestClient(app) as client:
        resp = client.delete("/runs", params={"status": "finished"})

    assert resp.status_code == 200
    assert resp.json()["deleted"] == 2

    # Running run's JSONL must still exist.
    assert (tmp_runs / f"{running_id}.jsonl").exists()

    # Finished runs' files must be gone.
    for i in range(2):
        assert not (tmp_runs / f"bulk-finished-{i}.jsonl").exists()


# ---------------------------------------------------------------------------
# POST /runs target routing (BYO vs reference)
# ---------------------------------------------------------------------------


@pytest.fixture()
def byo_seam(monkeypatch, tmp_path):
    """A registered command target + a recording stub for the spawner."""
    import saboteur.api.runs as runs_mod
    from saboteur.harness.targets import Target, TargetStore
    from saboteur.storage.db import Database

    store = TargetStore(Database(tmp_path / "saboteur.db"))
    store.add(Target(name="byo", kind="command", cmd=["python", "-c", "pass"]))
    monkeypatch.setattr(runs_mod, "_target_store", store)

    calls: list[tuple] = []

    async def _fake_byo(run_id, target, profile, n, *, runs_dir):
        calls.append((run_id, target.name, profile.name, n))

    monkeypatch.setattr(runs_mod, "_byo_runner", _fake_byo)
    return calls


def test_run_reference_target_unchanged(tmp_runs, clean_registry, fake_factory, byo_seam):
    """Default target='reference' runs the smolagents path; spawner untouched."""
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post(
            "/runs", json={"profile": "calm_seas", "n_agents": 1, "with_control": False}
        )
        assert resp.status_code == 202
        run_id = resp.json()["run_id"]
        for _ in range(20):
            if client.get(f"/runs/{run_id}").json()["status"] == "finished":
                break
            time.sleep(0.1)

    assert byo_seam == []  # the BYO spawner was never invoked


def test_run_byo_target_invokes_spawner(tmp_runs, clean_registry, byo_seam):
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post(
            "/runs", json={"target": "byo", "profile": "hell_mode", "n_agents": 4}
        )
        assert resp.status_code == 202
        run_id = resp.json()["run_id"]
        for _ in range(20):
            if client.get(f"/runs/{run_id}").json()["status"] == "finished":
                break
            time.sleep(0.1)

    assert len(byo_seam) == 1
    called_run_id, target_name, profile_name, n = byo_seam[0]
    assert called_run_id == run_id
    assert target_name == "byo"
    assert profile_name == "hell_mode"
    assert n == 4


def test_run_unknown_target_returns_404(tmp_runs, clean_registry, byo_seam):
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/runs", json={"target": "nope", "profile": "calm_seas"})
    assert resp.status_code == 404


def test_run_non_command_target_returns_400(tmp_runs, clean_registry, monkeypatch):
    """A registered target that isn't a command kind → 400 (defensive)."""
    import saboteur.api.runs as runs_mod
    from saboteur.harness.targets import Target

    class _FakeStore:
        def get(self, name):
            return Target(name=name, kind="reference")

    monkeypatch.setattr(runs_mod, "_target_store", _FakeStore())

    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/runs", json={"target": "weird", "profile": "calm_seas"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 7. The SQLite index: filtering, compare, restart-rebuild, DB-row deletion
# ---------------------------------------------------------------------------


def _scorecard_dict(run_id: str, profile: str, n_agents: int, **metrics) -> dict:
    base = {
        "run_id": run_id,
        "profile": profile,
        "n_agents": n_agents,
        "mttr_steps": None,
        "recovery_breakdown": {},
        "waste_factor": None,
        "failure_modes": {},
        "crash_rate": 0.0,
        "latency_degradation": None,
        "survival_rate": None,
        "deception_detection_rate": None,
        "per_agent": {},
    }
    base.update(metrics)
    return base


def _write_run_files(
    runs_dir: Path, run_id: str, profile: str, n_agents: int, scorecard: dict | None
) -> None:
    """A minimal JSONL (one run_started) + optional scorecard, on disk."""
    started = run_id.rsplit("-", 2)[1]  # YYYYmmddTHHMMSS
    iso = datetime.strptime(started, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    line = {
        "ts": iso.isoformat(),
        "run_id": run_id,
        "agent_id": -1,
        "step": None,
        "event": "run_started",
        "payload": {"profile": profile, "seed": 1337, "n_agents": n_agents},
    }
    (runs_dir / f"{run_id}.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    if scorecard is not None:
        (runs_dir / f"{run_id}.scorecard.json").write_text(
            json.dumps(scorecard), encoding="utf-8"
        )


def test_runs_filterable(tmp_runs, clean_registry):
    from saboteur.api import app

    a = "calm_seas-20260101T000000-aaaaaa"
    b = "hell_mode-20260103T000000-bbbbbb"
    _write_run_files(tmp_runs, a, "calm_seas", 2, _scorecard_dict(a, "calm_seas", 2, survival_rate=1.0))
    _write_run_files(tmp_runs, b, "hell_mode", 2, _scorecard_dict(b, "hell_mode", 2, survival_rate=0.1))

    with TestClient(app) as client:
        all_ids = {r["run_id"] for r in client.get("/runs").json()}
        assert {a, b} <= all_ids

        only_calm = client.get("/runs", params={"profile": "calm_seas"}).json()
        assert {r["run_id"] for r in only_calm} == {a}

        # Both are historical (archived) and reference-target.
        both_ref = client.get("/runs", params={"target": "reference"}).json()
        assert {a, b} <= {r["run_id"] for r in both_ref}
        archived = client.get("/runs", params={"status": "archived"}).json()
        assert {a, b} <= {r["run_id"] for r in archived}
        assert client.get("/runs", params={"status": "running"}).json() == []

        # Date filter on started_at (run_id stamp).
        late = client.get("/runs", params={"date_from": "2026-01-02"}).json()
        assert {r["run_id"] for r in late} == {b}


def test_compare_flags_regression(tmp_runs, clean_registry):
    from saboteur.api import app

    good = "calm_seas-20260101T000000-aaaaaa"
    bad = "calm_seas-20260102T000000-bbbbbb"
    _write_run_files(
        tmp_runs, good, "calm_seas", 4,
        _scorecard_dict(good, "calm_seas", 4, survival_rate=1.0, crash_rate=0.0, mttr_steps=2.0, waste_factor=1.0),
    )
    _write_run_files(
        tmp_runs, bad, "calm_seas", 4,
        _scorecard_dict(bad, "calm_seas", 4, survival_rate=0.5, crash_rate=0.3, mttr_steps=5.0, waste_factor=1.05),
    )

    with TestClient(app) as client:
        resp = client.get("/runs/compare", params={"a": good, "b": bad})
        assert resp.status_code == 200
        data = resp.json()

    m = data["metrics"]
    assert m["survival_rate"]["delta"] == -0.5 and m["survival_rate"]["regressed"] is True
    assert m["crash_rate"]["delta"] == 0.3 and m["crash_rate"]["regressed"] is True
    assert m["mttr_steps"]["delta"] == 3.0 and m["mttr_steps"]["regressed"] is True
    # waste_factor moved +0.05, under the 0.10 threshold → not a regression.
    assert m["waste_factor"]["regressed"] is False
    # null metrics never regress.
    assert m["latency_degradation"]["delta"] is None
    assert m["latency_degradation"]["regressed"] is False

    assert set(data["regressions"]) == {"survival_rate", "crash_rate", "mttr_steps"}


def test_compare_unknown_run_404(tmp_runs, clean_registry):
    from saboteur.api import app

    a = "calm_seas-20260101T000000-aaaaaa"
    _write_run_files(tmp_runs, a, "calm_seas", 2, _scorecard_dict(a, "calm_seas", 2, survival_rate=1.0))
    with TestClient(app) as client:
        resp = client.get("/runs/compare", params={"a": a, "b": "nope-20260101T000000-zzzzzz"})
    assert resp.status_code == 404


def test_compare_run_without_scorecard_409(tmp_runs, clean_registry):
    from saboteur.api import app

    a = "calm_seas-20260101T000000-aaaaaa"
    b = "calm_seas-20260102T000000-bbbbbb"
    _write_run_files(tmp_runs, a, "calm_seas", 2, _scorecard_dict(a, "calm_seas", 2, survival_rate=1.0))
    _write_run_files(tmp_runs, b, "calm_seas", 2, None)  # JSONL only, no scorecard
    with TestClient(app) as client:
        resp = client.get("/runs/compare", params={"a": a, "b": b})
    assert resp.status_code == 409


def test_runs_survive_restart_and_db_drop(tmp_runs, clean_registry):
    """Runs survive a restart; deleting the DB and restarting rebuilds it."""
    from saboteur.api import app

    rid = "flaky_friday-20260101T000000-aaaaaa"
    _write_run_files(tmp_runs, rid, "flaky_friday", 3, _scorecard_dict(rid, "flaky_friday", 3, survival_rate=0.66))

    # First server life: startup indexes it; it's listed.
    with TestClient(app) as client:
        assert rid in {r["run_id"] for r in client.get("/runs").json()}

    # Simulate a crash + DB loss: delete the SQLite file outright.
    db_path = tmp_runs / "saboteur.db"
    assert db_path.exists()
    db_path.unlink()
    for sidecar in ("saboteur.db-wal", "saboteur.db-shm"):
        (tmp_runs / sidecar).unlink(missing_ok=True)

    # Next server life (fresh registry): startup_index rebuilds from JSONL alone.
    clean_registry  # registry is empty (no live runs survive a restart)
    with TestClient(app) as client:
        listed = {r["run_id"]: r for r in client.get("/runs").json()}
        assert rid in listed
        assert listed[rid]["profile"] == "flaky_friday"
        assert listed[rid]["survival_pct"] == 66.0


def test_delete_removes_index_row(tmp_runs, clean_registry):
    from saboteur.api import app
    from saboteur.storage.db import db as index_db

    rid = "calm_seas-20260101T000000-aaaaaa"
    _write_run_files(tmp_runs, rid, "calm_seas", 2, _scorecard_dict(rid, "calm_seas", 2, survival_rate=1.0))

    with TestClient(app) as client:
        assert rid in {r["run_id"] for r in client.get("/runs").json()}
        assert index_db.run_get(rid) is not None

        resp = client.delete(f"/runs/{rid}")
        assert resp.status_code == 204

        assert index_db.run_get(rid) is None
        assert rid not in {r["run_id"] for r in client.get("/runs").json()}
        assert not (tmp_runs / f"{rid}.jsonl").exists()

