"""Acceptance tests for the FastAPI routes (LLM-free via FakeAgent injection).

Coverage:
  1. OpenAPI schema renders.
  2. GET /profiles — all four profiles listed with required fields.
  3. POST /runs lifecycle — starts, transitions to finished, scorecard readable.
  4. Unknown profile → 404.  Scorecard before finish → 425.
  5. GET /runs/{id}/events — pagination and after_ts filter.
  6. POST /replay — WS client receives all replayed events.
"""

from __future__ import annotations

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


def _fake_factory(agent_id, profile, store, on_event):
    return _FakeAgent(agent_id, on_event)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_runs(tmp_path: Path, monkeypatch):
    """Redirect all JSONL/scorecard writes to a temp directory."""
    import saboteur.api.runs as runs_mod
    import saboteur.api.replay as replay_mod
    import saboteur.telemetry.ws as ws_mod

    monkeypatch.setattr(runs_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(replay_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(ws_mod, "_RUNS_DIR", tmp_path)
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


def test_list_profiles_returns_all_four():
    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.get("/profiles")
    assert resp.status_code == 200
    names = {p["name"] for p in resp.json()}
    assert names == {"calm_seas", "flaky_friday", "hell_mode", "rate_limit_storm"}


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

