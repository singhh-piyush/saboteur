"""Run management routes.

POST   /runs                       — start a cohort run in the background; returns {run_id}
GET    /runs                       — list all runs: id, profile, n_agents, status,
                                     started_at, finished_at, survival_pct (if scored)
GET    /runs/{id}                  — status + per-agent summary
GET    /runs/{id}/scorecard        — Scorecard JSON (425 until finished; 404 if missing)
GET    /runs/{id}/events           — paginated JSONL event history (?after_ts= &limit=)
GET    /runs/{id}/download/jsonl   — download runs/{id}.jsonl
GET    /runs/{id}/download/scorecard — download runs/{id}.scorecard.json
DELETE /runs/{id}                  — delete files; 409 if run is RUNNING or PENDING
DELETE /runs?status=finished       — bulk delete finished runs; returns {"deleted": N}

Deletion is safe under concurrency: the run registry is the authoritative source
of liveness. We never delete files whose run_id is RUNNING or PENDING in the
registry, even if that process is not the one that created the files (archived
runs from previous server lives have no registry entry and are always deletable).

The ``_agent_factory`` module-level variable is the test seam: patch it with a
FakeAgent factory to exercise the full lifecycle without a live LLM.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from saboteur.agents.factory import build_agent
from saboteur.harness.cohort import AgentFactory
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
    n_agents: int
    status: str  # pending | running | finished | failed | archived
    started_at: datetime | None
    finished_at: datetime | None
    has_scorecard: bool
    survival_pct: float | None  # None until scored


def _survival_pct_from_scorecard(scorecard_path: Path) -> float | None:
    """Read survival_rate from a scorecard JSON file, return as percentage."""
    try:
        data = json.loads(scorecard_path.read_text(encoding="utf-8"))
        rate = data.get("survival_rate")
        if rate is not None:
            return float(rate) * 100.0
    except Exception:
        pass
    return None


@router.get("", response_model=list[RunListEntry])
def list_runs() -> list[RunListEntry]:
    """All known runs: this process's registry plus on-disk artifacts.

    Runs from earlier server lives have no registry entry; they surface as
    ``archived`` (their JSONL — and usually a scorecard — is still on disk,
    so they remain replayable). Control cohorts are folded into their run.
    """
    entries: dict[str, RunListEntry] = {}

    for state in run_registry.all():
        scorecard_path = _RUNS_DIR / f"{state.run_id}.scorecard.json"
        entries[state.run_id] = RunListEntry(
            run_id=state.run_id,
            profile=state.profile,
            n_agents=state.n_agents,
            status=state.status.value,
            started_at=state.started_at,
            finished_at=state.finished_at,
            has_scorecard=scorecard_path.exists(),
            survival_pct=_survival_pct_from_scorecard(scorecard_path)
            if scorecard_path.exists()
            else None,
        )

    if _RUNS_DIR.is_dir():
        for log in _RUNS_DIR.glob("*.jsonl"):
            run_id = log.stem
            if run_id.endswith("-control") or run_id in entries:
                continue
            scorecard = _RUNS_DIR / f"{run_id}.scorecard.json"
            profile = run_id.rsplit("-", 2)[0] if run_id.count("-") >= 2 else run_id
            n_agents = 0
            if scorecard.exists():
                try:
                    data = json.loads(scorecard.read_text(encoding="utf-8"))
                    profile = data.get("profile", profile)
                    n_agents = data.get("n_agents", 0)
                except Exception:
                    pass
            entries[run_id] = RunListEntry(
                run_id=run_id,
                profile=profile,
                n_agents=n_agents,
                status="archived",
                started_at=None,
                finished_at=None,
                has_scorecard=scorecard.exists(),
                survival_pct=_survival_pct_from_scorecard(scorecard)
                if scorecard.exists()
                else None,
            )

    # run_ids embed a UTC stamp; reverse-lexicographic ≈ newest first.
    return sorted(entries.values(), key=lambda e: e.run_id, reverse=True)


@router.post("", response_model=RunResponse, status_code=202)
async def start_run(req: RunRequest) -> RunResponse:
    """Launch a cohort run in the background."""
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
        except BaseException as exc:
            state.status = RunStatus.FAILED
            state.error = repr(exc)
            raise
        finally:
            state.finished_at = datetime.now(tz=timezone.utc)

    task = asyncio.create_task(_background())
    state.task = task
    return RunResponse(run_id=run_id)

@router.post("/{run_id}/cancel", status_code=200)
def cancel_run(run_id: str) -> dict:
    """Cancel an active run."""
    state = run_registry.get(run_id)
    if state is None or state.status not in (RunStatus.PENDING, RunStatus.RUNNING):
        raise HTTPException(400, "Run is not active")
    if state.task is not None:
        state.task.cancel()
    return {"status": "cancelled"}


@router.get("/{run_id}/download/jsonl")
def download_jsonl(run_id: str) -> FileResponse:
    """Download the raw JSONL event log for *run_id*."""
    path = _RUNS_DIR / f"{run_id}.jsonl"
    if not path.exists():
        raise HTTPException(404, f"JSONL log for run '{run_id}' not found")
    return FileResponse(
        path=str(path),
        media_type="application/x-ndjson",
        filename=f"{run_id}.jsonl",
    )


@router.get("/{run_id}/download/scorecard")
def download_scorecard(run_id: str) -> FileResponse:
    """Download the scorecard JSON for *run_id*."""
    path = _RUNS_DIR / f"{run_id}.scorecard.json"
    if not path.exists():
        raise HTTPException(404, f"Scorecard for run '{run_id}' not found")
    return FileResponse(
        path=str(path),
        media_type="application/json",
        filename=f"{run_id}.scorecard.json",
    )


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


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: str) -> None:
    """Delete all artifacts for *run_id*.

    Returns 409 if the run is currently RUNNING or PENDING (refuse to delete
    files that belong to an active run — check the registry, not file existence).
    Returns 404 if no artifacts exist and the run is not in the registry.
    """
    state = run_registry.get(run_id)

    if state is not None and state.status in (RunStatus.RUNNING, RunStatus.PENDING):
        raise HTTPException(
            409,
            f"run '{run_id}' is currently {state.status.value} — cannot delete",
        )

    jsonl = _RUNS_DIR / f"{run_id}.jsonl"
    scorecard = _RUNS_DIR / f"{run_id}.scorecard.json"
    control_jsonl = _RUNS_DIR / f"{run_id}-control.jsonl"
    control_scorecard = _RUNS_DIR / f"{run_id}-control.scorecard.json"

    files_existed = any(p.exists() for p in (jsonl, scorecard))
    if not files_existed and state is None:
        raise HTTPException(404, f"run '{run_id}' not found")

    for path in (jsonl, scorecard, control_jsonl, control_scorecard):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


@router.delete("", status_code=200)
def bulk_delete_runs(
    status: str = Query(..., description="Must be 'finished'"),
) -> dict:
    """Bulk delete finished runs.

    Only ``status=finished`` is accepted (422 otherwise).  Skips any run that
    is currently RUNNING or PENDING in the registry — active runs are never
    touched.  Returns ``{"deleted": N}`` where N is the number of run IDs
    whose files were removed.
    """
    if status != "finished":
        raise HTTPException(
            422,
            f"bulk delete only supports status='finished', got {status!r}",
        )

    deleted = 0
    if not _RUNS_DIR.is_dir():
        return {"deleted": 0}

    # Collect all non-control run IDs that have a JSONL file.
    run_ids: list[str] = [
        log.stem
        for log in _RUNS_DIR.glob("*.jsonl")
        if not log.stem.endswith("-control")
    ]

    for run_id in run_ids:
        reg_state = run_registry.get(run_id)
        if reg_state is not None and reg_state.status in (
            RunStatus.RUNNING,
            RunStatus.PENDING,
        ):
            # Active run — skip silently.
            continue

        jsonl = _RUNS_DIR / f"{run_id}.jsonl"
        scorecard = _RUNS_DIR / f"{run_id}.scorecard.json"
        control_jsonl = _RUNS_DIR / f"{run_id}-control.jsonl"
        control_scorecard = _RUNS_DIR / f"{run_id}-control.scorecard.json"

        for path in (jsonl, scorecard, control_jsonl, control_scorecard):
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass

        deleted += 1

    return {"deleted": deleted}


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
