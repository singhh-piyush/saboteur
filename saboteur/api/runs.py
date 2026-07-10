
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
from saboteur.harness.spawn import run_byo_cohort
from saboteur.harness.targets import target_store
from saboteur.storage.db import RunRow, db, derive_target, reconcile_runs
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent

from .state import RunState, RunStatus, run_registry

router = APIRouter(prefix="/runs", tags=["runs"])

_RUNS_DIR = Path("runs")
_PROFILES_DIR = Path("profiles")

_db = db


def startup_index() -> None:
    from saboteur.storage.db import backfill

    try:
        backfill(_db, _RUNS_DIR, _PROFILES_DIR)
    except Exception:
        pass

_agent_factory: AgentFactory = build_agent
_target_store = target_store
_byo_runner = run_byo_cohort




class RunRequest(BaseModel):
    profile: str
    n_agents: int | None = None
    seed_override: int | None = None
    with_control: bool = True
    target: str = "reference"


class RunResponse(BaseModel):
    run_id: str


class AgentSummary(BaseModel):
    status: str
    step: int | None
    faults: int
    recoveries: int


class RunStatusResponse(BaseModel):
    run_id: str
    target: str
    profile: str
    n_agents: int
    with_control: bool
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    has_scorecard: bool
    survival_rate: float | None
    agents: dict[str, AgentSummary]




class RunListEntry(BaseModel):
    run_id: str
    target: str
    profile: str
    n_agents: int
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    has_scorecard: bool
    survival_pct: float | None


def _to_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def _entry_from_row(row: RunRow) -> RunListEntry:
    return RunListEntry(
        run_id=row.run_id,
        target=row.target or "reference",
        profile=row.profile or "",
        n_agents=row.n_agents,
        status="archived",
        started_at=_to_dt(row.started_at),
        finished_at=_to_dt(row.finished_at),
        has_scorecard=row.has_scorecard,
        survival_pct=row.survival_rate * 100.0 if row.survival_rate is not None else None,
    )


def _matches(
    entry: RunListEntry,
    *,
    target: str | None,
    profile: str | None,
    status: str | None,
    date_from: str | None,
    date_to: str | None,
) -> bool:
    if target is not None and entry.target != target:
        return False
    if profile is not None and entry.profile != profile:
        return False
    if status is not None and entry.status != status:
        return False
    if (date_from or date_to) and entry.started_at is not None:
        started = entry.started_at.date().isoformat()
        if date_from is not None and started < date_from:
            return False
        if date_to is not None and started > date_to:
            return False
    elif (date_from or date_to) and entry.started_at is None:
        return False  # a date filter excludes runs with no known start
    return True


@router.get("", response_model=list[RunListEntry])
def list_runs(
    target: str | None = None,
    profile: str | None = None,
    status: str | None = None,
    date_from: str | None = Query(None, description="ISO date (YYYY-MM-DD), inclusive"),
    date_to: str | None = Query(None, description="ISO date (YYYY-MM-DD), inclusive"),
) -> list[RunListEntry]:
    reconcile_runs(_db, _RUNS_DIR)

    entries: dict[str, RunListEntry] = {
        row.run_id: _entry_from_row(row) for row in _db.runs_all()
    }

    for state in run_registry.all():
        if state.run_id.endswith("-control"):
            continue
        scorecard_path = _RUNS_DIR / f"{state.run_id}.scorecard.json"
        existing = entries.get(state.run_id)
        entries[state.run_id] = RunListEntry(
            run_id=state.run_id,
            target=existing.target if existing else derive_target(state.run_id, state.profile),
            profile=state.profile,
            n_agents=state.n_agents,
            status=state.status.value,
            started_at=state.started_at,
            finished_at=state.finished_at,
            has_scorecard=scorecard_path.exists(),
            survival_pct=existing.survival_pct if existing else None,
        )

    selected = [
        e
        for e in entries.values()
        if _matches(
            e,
            target=target,
            profile=profile,
            status=status,
            date_from=date_from,
            date_to=date_to,
        )
    ]
    return sorted(selected, key=lambda e: e.run_id, reverse=True)


class MetricDelta(BaseModel):
    a: float | None
    b: float | None
    delta: float | None
    regressed: bool
    higher_is_better: bool
    threshold: float


class RunComparison(BaseModel):
    a: str
    b: str
    metrics: dict[str, MetricDelta]
    regressions: list[str]


_COMPARE_METRICS: list[tuple[str, bool, float]] = [
    ("survival_rate", True, 0.05),
    ("deception_detection_rate", True, 0.05),
    ("mttr_steps", False, 0.5),
    ("waste_factor", False, 0.10),
    ("crash_rate", False, 0.05),
    ("latency_degradation", False, 0.10),
]


def _summary_or_404(run_id: str) -> dict:
    row = _db.run_get(run_id)
    if row is None:
        raise HTTPException(404, f"run '{run_id}' not found")
    if not row.summary:
        raise HTTPException(409, f"run '{run_id}' has no scorecard to compare")
    try:
        return json.loads(row.summary)
    except ValueError:
        raise HTTPException(409, f"run '{run_id}' scorecard is unreadable")


@router.get("/compare", response_model=RunComparison)
def compare_runs(a: str, b: str) -> RunComparison:
    reconcile_runs(_db, _RUNS_DIR)
    sca = _summary_or_404(a)
    scb = _summary_or_404(b)

    metrics: dict[str, MetricDelta] = {}
    regressions: list[str] = []
    for name, higher_is_better, threshold in _COMPARE_METRICS:
        va = sca.get(name)
        vb = scb.get(name)
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            delta = vb - va
            worse_by = (va - vb) if higher_is_better else (vb - va)
            regressed = worse_by > threshold
        else:
            delta = None
            regressed = False
        metrics[name] = MetricDelta(
            a=va if isinstance(va, (int, float)) else None,
            b=vb if isinstance(vb, (int, float)) else None,
            delta=delta,
            regressed=regressed,
            higher_is_better=higher_is_better,
            threshold=threshold,
        )
        if regressed:
            regressions.append(name)

    return RunComparison(a=a, b=b, metrics=metrics, regressions=regressions)


@router.post("", response_model=RunResponse, status_code=202)
async def start_run(req: RunRequest) -> RunResponse:
    profile_path = _PROFILES_DIR / f"{req.profile}.yaml"
    if not profile_path.exists():
        raise HTTPException(404, f"profile '{req.profile}' not found")

    from saboteur.config import get_settings
    n = req.n_agents or get_settings().n_agents

    if req.target != "reference":
        return await _start_byo_run(req, n)

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


async def _start_byo_run(req: RunRequest, n: int) -> RunResponse:
    from saboteur.chaos.profile import load_profile

    target = _target_store.get(req.target)
    if target is None:
        raise HTTPException(404, f"target '{req.target}' not found")
    if target.kind != "command":
        raise HTTPException(400, f"target '{req.target}' is not a command target")

    profile = load_profile(_PROFILES_DIR / f"{req.profile}.yaml")
    if req.seed_override is not None:
        profile = profile.model_copy(update={"seed": req.seed_override})

    run_id = make_run_id(req.target)
    # pre-register to avoid websocket race
    state = RunState(
        run_id=run_id,
        profile=req.profile,
        n_agents=n,
        with_control=False,
        status=RunStatus.RUNNING,
        started_at=datetime.now(tz=timezone.utc),
    )
    run_registry.add(state)

    async def _background() -> None:
        try:
            await _byo_runner(run_id, target, profile, n, runs_dir=_RUNS_DIR)
            state.status = RunStatus.FINISHED
        except BaseException as exc:
            state.status = RunStatus.FAILED
            state.error = repr(exc)
            raise
        finally:
            state.finished_at = datetime.now(tz=timezone.utc)

    state.task = asyncio.create_task(_background())
    return RunResponse(run_id=run_id)

@router.post("/{run_id}/cancel", status_code=200)
async def cancel_run(run_id: str) -> dict:
    from saboteur.proxy.session import manager as proxy_manager

    proxy_run = proxy_manager.get(run_id)
    if proxy_run is not None:
        await proxy_run.finish()
        return {"status": "finished"}

    state = run_registry.get(run_id)
    if state is None or state.status not in (RunStatus.PENDING, RunStatus.RUNNING):
        raise HTTPException(400, "Run is not active")
    if state.task is not None:
        state.task.cancel()
    return {"status": "cancelled"}


@router.get("/{run_id}/download/jsonl")
def download_jsonl(run_id: str) -> FileResponse:
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

    row = _db.run_get(run_id)
    target = row.target if row and row.target else derive_target(run_id, state.profile)
    survival_rate = row.survival_rate if row else None

    return RunStatusResponse(
        run_id=state.run_id,
        target=target or "reference",
        profile=state.profile,
        n_agents=state.n_agents,
        with_control=state.with_control,
        status=state.status.value,
        started_at=state.started_at,
        finished_at=state.finished_at,
        error=state.error,
        has_scorecard=(_RUNS_DIR / f"{run_id}.scorecard.json").exists(),
        survival_rate=survival_rate,
        agents=_agent_summaries(events),
    )


@router.get("/{run_id}/scorecard", response_model=Scorecard)
def get_scorecard(run_id: str) -> Scorecard:
    path = _RUNS_DIR / f"{run_id}.scorecard.json"
    state = run_registry.get(run_id)
    if state is None:
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
    state = run_registry.get(run_id)
    log = _RUNS_DIR / f"{run_id}.jsonl"
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
    row_existed = _db.run_get(run_id) is not None
    if not files_existed and not row_existed and state is None:
        raise HTTPException(404, f"run '{run_id}' not found")

    for path in (jsonl, scorecard, control_jsonl, control_scorecard):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
    _db.run_delete(run_id)


@router.delete("", status_code=200)
def bulk_delete_runs(
    status: str = Query(..., description="Must be 'finished'"),
) -> dict:
    if status != "finished":
        raise HTTPException(
            422,
            f"bulk delete only supports status='finished', got {status!r}",
        )

    deleted = 0
    if not _RUNS_DIR.is_dir():
        return {"deleted": 0}

    run_ids: set[str] = {
        log.stem
        for log in _RUNS_DIR.glob("*.jsonl")
        if not log.stem.endswith("-control")
    }
    run_ids.update(
        sc.name.removesuffix(".scorecard.json")
        for sc in _RUNS_DIR.glob("*.scorecard.json")
        if not sc.name.removesuffix(".scorecard.json").endswith("-control")
    )

    for run_id in sorted(run_ids):
        reg_state = run_registry.get(run_id)
        if reg_state is not None and reg_state.status in (
            RunStatus.RUNNING,
            RunStatus.PENDING,
        ):
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
        _db.run_delete(run_id)

        deleted += 1

    return {"deleted": deleted}




def _archived_state(run_id: str) -> RunState | None:
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
            verdict = done.payload.get("success")
            status = (
                "unknown"
                if verdict is None
                else "succeeded"
                if verdict
                else "failed"
            )
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
