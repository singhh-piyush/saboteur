"""SQLite index tests — temp-path Database.

The contract (invariant #3): the index is a *cache* over ``runs/*.jsonl`` +
``*.scorecard.json``. Everything here is reconstructable from those files alone
— drop the DB, rebuild, and every row comes back. Scoring/replay never read the
DB, so live-vs-replay parity is untouched.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from saboteur.harness.scoring import score
from saboteur.storage.db import (
    Database,
    backfill,
    build_run_row,
    derive_target,
    reconcile_runs,
)
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _ev(run_id: str, event: str, *, agent_id: int, step=None, ts, payload=None, **kw):
    return TelemetryEvent(
        run_id=run_id,
        agent_id=agent_id,
        step=step,
        event=event,
        ts=ts,
        payload=payload or {},
        **kw,
    )


def _write_run(
    runs_dir: Path,
    run_id: str,
    *,
    profile: str,
    n_agents: int,
    started: datetime,
    finished: datetime | None = None,
    scorecard: dict | None = None,
) -> list[TelemetryEvent]:
    # Write a run's JSONL (run_started [+ a done] [+ run_finished]) + scorecard.
    runs_dir.mkdir(parents=True, exist_ok=True)
    events: list[TelemetryEvent] = [
        _ev(
            run_id,
            "run_started",
            agent_id=-1,
            ts=started,
            payload={"profile": profile, "seed": 1337, "n_agents": n_agents},
        )
    ]
    for aid in range(n_agents):
        events.append(
            _ev(
                run_id,
                "agent_done",
                agent_id=aid,
                ts=started,
                tokens_used=100,
                payload={"outcome": "completed", "success": True, "steps_taken": 3},
            )
        )
    if finished is not None:
        events.append(
            _ev(
                run_id,
                "run_finished",
                agent_id=-1,
                ts=finished,
                payload={"n_agents": n_agents, "outcomes": {"completed": n_agents}},
            )
        )
    with (runs_dir / f"{run_id}.jsonl").open("w", encoding="utf-8") as fh:
        for e in events:
            fh.write(e.model_dump_json() + "\n")
    if scorecard is not None:
        (runs_dir / f"{run_id}.scorecard.json").write_text(
            json.dumps(scorecard), encoding="utf-8"
        )
    return events


def _scorecard(run_id, profile, n_agents, **metrics) -> dict:
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


# ---------------------------------------------------------------------------
# derive_target — JSONL-only target reconstruction
# ---------------------------------------------------------------------------


def test_derive_target_reference_vs_byo():
    assert derive_target("calm_seas-20260101T000000-abc123", "calm_seas") == "reference"
    assert derive_target("mybot-20260101T000000-abc123", "hell_mode") == "mybot"
    # A BYO target name may itself contain hyphens.
    assert derive_target("my-cool-bot-20260101T000000-abc123", "hell_mode") == "my-cool-bot"


# ---------------------------------------------------------------------------
# build_run_row / reconcile
# ---------------------------------------------------------------------------


def test_build_run_row_from_scorecard(tmp_path):
    started = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    finished = datetime(2026, 1, 2, 3, 5, 0, tzinfo=timezone.utc)
    _write_run(
        tmp_path,
        "flaky_friday-20260102T030405-aaaaaa",
        profile="flaky_friday",
        n_agents=4,
        started=started,
        finished=finished,
        scorecard=_scorecard(
            "flaky_friday-20260102T030405-aaaaaa", "flaky_friday", 4, survival_rate=0.75
        ),
    )
    row = build_run_row(tmp_path, "flaky_friday-20260102T030405-aaaaaa")
    assert row is not None
    assert row.profile == "flaky_friday"
    assert row.n_agents == 4
    assert row.target == "reference"
    assert row.has_scorecard is True
    assert row.status == "finished"
    assert row.survival_rate == 0.75
    assert _parse(row.started_at) == started
    assert _parse(row.finished_at) == finished
    assert json.loads(row.summary)["survival_rate"] == 0.75


def test_reconcile_indexes_and_prunes(tmp_path):
    db = Database(tmp_path / "saboteur.db")
    run_id = "calm_seas-20260101T000000-aaaaaa"
    _write_run(
        tmp_path,
        run_id,
        profile="calm_seas",
        n_agents=2,
        started=datetime(2026, 1, 1, tzinfo=timezone.utc),
        finished=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
        scorecard=_scorecard(run_id, "calm_seas", 2, survival_rate=1.0),
    )
    # Control logs are never indexed.
    (tmp_path / f"{run_id}-control.jsonl").write_text("")

    reconcile_runs(db, tmp_path)
    assert db.run_get(run_id) is not None
    assert db.run_get(f"{run_id}-control") is None

    # Remove the run's JSONL → reconcile prunes its row (disk is the truth).
    (tmp_path / f"{run_id}.jsonl").unlink()
    reconcile_runs(db, tmp_path)
    assert db.run_get(run_id) is None


def test_reconcile_skips_replay_sessions(tmp_path):
    # replay-* JSONLs are dashboard re-emissions, never indexed as runs.
    db = Database(tmp_path / "saboteur.db")
    replay_id = "replay-20260101T000000-cccccc"
    _write_run(
        tmp_path,
        replay_id,
        profile="hell_mode",
        n_agents=2,
        started=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    reconcile_runs(db, tmp_path)
    assert db.run_get(replay_id) is None
    assert replay_id not in db.run_ids()


def test_reconcile_picks_up_new_scorecard(tmp_path):
    db = Database(tmp_path / "saboteur.db")
    run_id = "hell_mode-20260101T000000-bbbbbb"
    # First: JSONL only (a run captured mid-flight / before scoring).
    _write_run(
        tmp_path,
        run_id,
        profile="hell_mode",
        n_agents=3,
        started=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    reconcile_runs(db, tmp_path)
    row = db.run_get(run_id)
    assert row is not None and row.has_scorecard is False and row.status == "archived"

    # Scorecard appears → reconcile re-indexes the row.
    (tmp_path / f"{run_id}.scorecard.json").write_text(
        json.dumps(_scorecard(run_id, "hell_mode", 3, survival_rate=0.33))
    )
    reconcile_runs(db, tmp_path)
    row = db.run_get(run_id)
    assert row is not None and row.has_scorecard is True and row.status == "finished"
    assert row.survival_rate == 0.33


# ---------------------------------------------------------------------------
# Acceptance: drop the DB, rebuild from JSONL alone
# ---------------------------------------------------------------------------


def test_drop_db_and_rebuild_from_disk(tmp_path):
    runs_dir = tmp_path / "runs"
    db_path = tmp_path / "runs" / "saboteur.db"
    ids = []
    for i in range(3):
        rid = f"flaky_friday-2026010{i}T000000-cccccc"
        ids.append(rid)
        _write_run(
            runs_dir,
            rid,
            profile="flaky_friday",
            n_agents=2,
            started=datetime(2026, 1, 1 + i, tzinfo=timezone.utc),
            finished=datetime(2026, 1, 1 + i, 0, 1, tzinfo=timezone.utc),
            scorecard=_scorecard(rid, "flaky_friday", 2, survival_rate=0.5),
        )

    db1 = Database(db_path)
    backfill(db1, runs_dir, tmp_path / "profiles")
    before = {r.run_id: r for r in db1.runs_all()}
    assert set(before) == set(ids)

    # Nuke the DB entirely, then rebuild on a fresh handle — everything returns.
    db_path.unlink()
    for sidecar in ("-wal", "-shm"):
        (db_path.parent / (db_path.name + sidecar)).unlink(missing_ok=True)

    db2 = Database(db_path)
    backfill(db2, runs_dir, tmp_path / "profiles")
    after = {r.run_id: r for r in db2.runs_all()}
    assert set(after) == set(ids)
    for rid in ids:
        assert after[rid].profile == before[rid].profile
        assert after[rid].survival_rate == before[rid].survival_rate
        assert after[rid].started_at == before[rid].started_at


# ---------------------------------------------------------------------------
# Invariant #3: scoring/replay are independent of the index
# ---------------------------------------------------------------------------


def test_scoring_is_independent_of_index(tmp_path):
    # Re-scoring the JSONL == the on-disk scorecard == what the index caches.
    runs_dir = tmp_path / "runs"
    run_id = "calm_seas-20260101T000000-dddddd"
    events = _write_run(
        runs_dir,
        run_id,
        profile="calm_seas",
        n_agents=2,
        started=datetime(2026, 1, 1, tzinfo=timezone.utc),
        finished=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
    )
    # Replay-score the JSONL and persist that as the scorecard (no DB involved).
    sc_live = score(events, [], run_id=run_id, profile="calm_seas")
    (runs_dir / f"{run_id}.scorecard.json").write_text(sc_live.model_dump_json())

    # Index it, then re-score the JSONL from disk.
    db = Database(runs_dir / "saboteur.db")
    reconcile_runs(db, runs_dir)
    sc_replay = score(
        read_jsonl(runs_dir / f"{run_id}.jsonl"), [], run_id=run_id, profile="calm_seas"
    )

    # All three agree: replay == live == index summary.
    assert sc_replay == sc_live
    cached = json.loads(db.run_get(run_id).summary)
    assert cached["survival_rate"] == sc_live.survival_rate
    assert cached == json.loads(sc_live.model_dump_json())
