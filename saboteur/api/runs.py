"""Run management routes.

POST /runs          — start a battle-royale in the background; returns {run_id}
GET  /runs/{id}     — status (pending|running|finished|failed) + per-agent summary
GET  /runs/{id}/scorecard — Scorecard JSON (425 until finished; 404 if missing)
GET  /runs/{id}/events    — paginated JSONL event history (?after_ts= &limit=)

The ``_agent_factory`` module-level variable is the test seam: patch it with a
FakeAgent factory to exercise the full lifecycle without a live LLM.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from saboteur.agents.factory import build_agent
from saboteur.harness.battle import AgentFactory
from saboteur.harness.runner import make_run_id, orchestrate
from saboteur.harness.scoring import Scorecard
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent

from .state import RunState, RunStatus, run_registry

router = APIRouter(prefix="/runs", tags=["runs"])

_RUNS_DIR = Path("runs")
_PROFILES_DIR = Path("profiles")

# Override in tests: monkeypatch.setattr(runs_mod, "_agent_factory", fake)
_agent_factory: AgentFactory = build_agent


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class RunRequest(BaseModel):
    profile: str
    n_agents: int | None = None
    seed_override: int | None = None
    with_control: bool = True


class RunResponse(BaseModel):
    run_id: str


class AgentSummary(BaseModel):
    status: str  # running | recovering | crashed | succeeded | failed
    step: int | None
    faults: int
    recoveries: int


class RunStatusResponse(BaseModel):
    run_id: str
    profile: str
    n_agents: int
    with_control: bool
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    agents: dict[str, AgentSummary]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


class RunListEntry(BaseModel):
    run_id: str
    profile: str
    status: str  # pending | running | finished | failed | archived
    has_scorecard: bool


@router.get("", response_model=list[RunListEntry])
def list_runs() -> list[RunListEntry]:
    """All known runs: this process's registry plus on-disk artifacts.

    Runs from earlier server lives have no registry entry; they surface as
    ``archived`` (their JSONL — and usually a scorecard — is still on disk,
    so they remain replayable). Control cohorts are folded into their run.
    """
    entries: dict[str, RunListEntry] = {}

    for state in run_registry.all():
        entries[state.run_id] = RunListEntry(
            run_id=state.run_id,
            profile=state.profile,
            status=state.status.value,
            has_scorecard=(_RUNS_DIR / f"{state.run_id}.scorecard.json").exists(),
        )

    if _RUNS_DIR.is_dir():
        for log in _RUNS_DIR.glob("*.jsonl"):
            run_id = log.stem
            if run_id.endswith("-control") or run_id in entries:
                continue
            scorecard = _RUNS_DIR / f"{run_id}.scorecard.json"
            profile = run_id.rsplit("-", 2)[0] if run_id.count("-") >= 2 else run_id
            if scorecard.exists():
                try:
                    profile = json.loads(scorecard.read_text(encoding="utf-8"))["profile"]
                except Exception:
                    pass
            entries[run_id] = RunListEntry(
                run_id=run_id,
                profile=profile,
                status="archived",
                has_scorecard=scorecard.exists(),
            )

    # run_ids embed a UTC stamp; reverse-lexicographic ≈ newest first.
    return sorted(entries.values(), key=lambda e: e.run_id, reverse=True)


@router.post("", response_model=RunResponse, status_code=202)
async def start_run(req: RunRequest) -> RunResponse:
    """Launch a battle-royale run in the background."""
    profile_path = _PROFILES_DIR / f"{req.profile}.yaml"
    if not profile_path.exists():
        raise HTTPException(404, f"profile '{req.profile}' not found")

    from saboteur.config import get_settings
    n = req.n_agents or get_settings().n_agents

    run_id = make_run_id(req.profile)
    state = RunState(
        run_id=run_id,
        profile=req.profile,
        n_agents=n,
        with_control=req.with_control,
    )
    run_registry.add(state)

    async def _background() -> None:
        state.status = RunStatus.RUNNING
        state.started_at = datetime.now(tz=timezone.utc)
        try:
            await orchestrate(
                profile_path=profile_path,
                n_agents=n,
                run_id=run_id,
                seed_override=req.seed_override,
                with_control=req.with_control,
                runs_dir=_RUNS_DIR,
                agent_factory=_agent_factory,
            )
            state.status = RunStatus.FINISHED
        except Exception as exc:
            state.status = RunStatus.FAILED
            state.error = repr(exc)
        finally:
            state.finished_at = datetime.now(tz=timezone.utc)

    asyncio.create_task(_background())
    return RunResponse(run_id=run_id)


@router.get("/{run_id}", response_model=RunStatusResponse)
def get_run(run_id: str) -> RunStatusResponse:
    """Run status plus a per-agent summary (read from JSONL)."""
    state = run_registry.get(run_id) or _archived_state(run_id)
    if state is None:
        raise HTTPException(404, f"run '{run_id}' not found")

    events: list[TelemetryEvent] = []
    log = _RUNS_DIR / f"{run_id}.jsonl"
    if log.exists():
        try:
            events = read_jsonl(log)
        except Exception:
            pass

    return RunStatusResponse(
        run_id=state.run_id,
        profile=state.profile,
        n_agents=state.n_agents,
        with_control=state.with_control,
        status=state.status.value,
        started_at=state.started_at,
        finished_at=state.finished_at,
        error=state.error,
        agents=_agent_summaries(events),
    )


@router.get("/{run_id}/scorecard", response_model=Scorecard)
def get_scorecard(run_id: str) -> Scorecard:
    """Return the persisted Scorecard (404 until the run finishes)."""
    path = _RUNS_DIR / f"{run_id}.scorecard.json"
    state = run_registry.get(run_id)
    if state is None:
        # Archived run from a previous server life: serve straight from disk.
        if path.exists():
            return Scorecard.model_validate_json(path.read_text(encoding="utf-8"))
        raise HTTPException(404, f"run '{run_id}' not found")
    if state.status in (RunStatus.PENDING, RunStatus.RUNNING):
        raise HTTPException(425, "scorecard not ready yet")
    if not path.exists():
        raise HTTPException(404, "scorecard file missing")
    return Scorecard.model_validate_json(path.read_text(encoding="utf-8"))


@router.get("/{run_id}/events")
def get_events(
    run_id: str,
    after_ts: str | None = None,
    limit: int = 200,
) -> list[dict]:
    """Paginated event history from JSONL.

    Use ``after_ts`` (ISO-8601) as a cursor to page forward.
    """
    state = run_registry.get(run_id)
    log = _RUNS_DIR / f"{run_id}.jsonl"
    # Archived runs (and -control cohorts) have no registry entry but their
    # JSONL is on disk and stays replayable across server restarts.
    if state is None and not log.exists():
        raise HTTPException(404, f"run '{run_id}' not found")
    if not log.exists():
        return []

    events = read_jsonl(log)

    if after_ts is not None:
        try:
            cutoff = datetime.fromisoformat(after_ts)
        except ValueError:
            raise HTTPException(422, f"invalid after_ts: {after_ts!r}")
        events = [e for e in events if e.ts > cutoff]

    return [json.loads(e.model_dump_json()) for e in events[:limit]]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _archived_state(run_id: str) -> RunState | None:
    """Synthesize a RunState for a run whose artifacts survive on disk."""
    scorecard = _RUNS_DIR / f"{run_id}.scorecard.json"
    log = _RUNS_DIR / f"{run_id}.jsonl"
    if not scorecard.exists() and not log.exists():
        return None
    profile = run_id.rsplit("-", 2)[0] if run_id.count("-") >= 2 else run_id
    n_agents = 0
    if scorecard.exists():
        try:
            data = json.loads(scorecard.read_text(encoding="utf-8"))
            profile = data.get("profile", profile)
            n_agents = data.get("n_agents", 0)
        except Exception:
            pass
    return RunState(
        run_id=run_id,
        profile=profile,
        n_agents=n_agents,
        with_control=False,
        status=RunStatus.FINISHED if scorecard.exists() else RunStatus.FAILED,
    )


def _agent_summaries(events: list[TelemetryEvent]) -> dict[str, AgentSummary]:
    by_agent: dict[int, list[TelemetryEvent]] = {}
    for e in events:
        if e.agent_id >= 0:
            by_agent.setdefault(e.agent_id, []).append(e)

    result: dict[str, AgentSummary] = {}
    for agent_id, aevents in by_agent.items():
        done = next((e for e in reversed(aevents) if e.event == "agent_done"), None)
        crashed = any(e.event == "agent_crashed" for e in aevents)
        last_step = max((e.step for e in aevents if e.step is not None), default=None)
        faults = sum(1 for e in aevents if e.event == "fault_injected")
        recoveries = sum(1 for e in aevents if e.event == "recovery_action")

        if done is not None:
            status = "succeeded" if done.payload.get("success") else "failed"
        elif crashed:
            status = "crashed"
        elif any(e.event == "recovery_action" for e in aevents):
            status = "recovering"
        else:
            status = "running"

        result[str(agent_id)] = AgentSummary(
            status=status, step=last_step, faults=faults, recoveries=recoveries
        )
    return result
