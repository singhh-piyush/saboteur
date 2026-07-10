
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from saboteur.agents.outcomes import StepRecord
from saboteur.chaos.profile import load_profile
from saboteur.config import get_settings
from saboteur.harness.runner import make_run_id
from saboteur.proxy.session import manager
from saboteur.telemetry.schema import TelemetryEvent

router = APIRouter(tags=["mcp"])

_RUNS_DIR = Path("runs")
_PROFILES_DIR = Path("profiles")


class McpRunRequest(BaseModel):
    profile: str
    n_agents: int | None = Field(default=None, ge=1)
    seed_override: int | None = None


class McpRunResponse(BaseModel):
    run_id: str
    seed: int


@router.get("/mcp/health")
def mcp_health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/mcp/runs", response_model=McpRunResponse, status_code=202)
async def start_mcp_run(req: McpRunRequest) -> McpRunResponse:
    profile_path = _PROFILES_DIR / f"{req.profile}.yaml"
    if not profile_path.exists():
        raise HTTPException(404, f"profile '{req.profile}' not found")
    profile = load_profile(profile_path)
    if req.seed_override is not None:
        profile = profile.model_copy(update={"seed": req.seed_override})

    n = req.n_agents or get_settings().n_agents
    run_id = make_run_id(profile.name)
    await manager.create(run_id, profile, n, runs_dir=_RUNS_DIR)
    return McpRunResponse(run_id=run_id, seed=profile.seed)


@router.post("/mcp/runs/{run_id}/events", status_code=202)
async def ingest_event(run_id: str, event: TelemetryEvent) -> dict[str, bool]:
    run = manager.get(run_id)
    if run is None:
        raise HTTPException(404, f"mcp run '{run_id}' not found")
    run.touch()
    if event.agent_id >= 0 and event.event == "tool_call" and event.step is not None:
        sess = run.session(event.agent_id)
        if event.step > sess.step:
            sess.step = event.step
            sess.history.append(_record_from_event(event))
    run.emit(event)
    return {"ok": True}


@router.post("/mcp/runs/{run_id}/finish", status_code=200)
async def finish_mcp_run(run_id: str) -> dict[str, str]:
    run = manager.get(run_id)
    if run is None:
        raise HTTPException(404, f"mcp run '{run_id}' not found")
    await run.finish()
    return {"status": "finished", "run_id": run_id}


def _record_from_event(event: TelemetryEvent) -> StepRecord:
    p = event.payload
    return StepRecord(
        step=event.step or 0,
        tool_name=p.get("tool"),
        arguments=p.get("arguments"),
        faulted=bool(p.get("sabotaged")),
        fault_types=tuple(p.get("fault_types") or ()),
        errored=bool(p.get("errored")),
        observation=None,
    )
