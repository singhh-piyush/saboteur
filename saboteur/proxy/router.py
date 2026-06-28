"""FastAPI routes for the wire proxy (mounted on the dashboard app).

- ``POST /proxy/runs`` — start a proxy run (profile + n_agents) → ``{run_id}``.
- ``POST /proxy/runs/{run_id}/finish`` — emit terminals, score, tear down.
- ``POST /v1/chat/completions`` — the OpenAI endpoint a BYO agent points at.
  Attribution comes from the ``X-Saboteur-Run-Id`` / ``X-Saboteur-Agent-Id``
  headers; with no (or an unknown) run id the proxy is a transparent passthrough.
- ``GET /v1/models`` — passthrough to the upstream.
- ``GET /proxy/health``.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from saboteur.chaos.profile import load_profile
from saboteur.config import get_settings
from saboteur.harness.runner import make_run_id

from . import forward, inject
from .session import manager

router = APIRouter(tags=["proxy"])

_RUNS_DIR = Path("runs")
_PROFILES_DIR = Path("profiles")


class ProxyRunRequest(BaseModel):
    profile: str
    n_agents: int | None = Field(default=None, ge=1)
    seed_override: int | None = None


class ProxyRunResponse(BaseModel):
    run_id: str


@router.get("/proxy/health")
def proxy_health() -> dict[str, str]:
    return {"status": "ok", "upstream": get_settings().upstream_base_url}


@router.post("/proxy/runs", response_model=ProxyRunResponse, status_code=202)
async def start_proxy_run(req: ProxyRunRequest) -> ProxyRunResponse:
    """Register a proxy run so BYO-agent traffic bearing its id gets sabotaged."""
    profile_path = _PROFILES_DIR / f"{req.profile}.yaml"
    if not profile_path.exists():
        raise HTTPException(404, f"profile '{req.profile}' not found")
    profile = load_profile(profile_path)
    if req.seed_override is not None:
        profile = profile.model_copy(update={"seed": req.seed_override})

    n = req.n_agents or get_settings().n_agents
    run_id = make_run_id(profile.name)
    await manager.create(run_id, profile, n, runs_dir=_RUNS_DIR)
    return ProxyRunResponse(run_id=run_id)


@router.post("/proxy/runs/{run_id}/finish", status_code=200)
async def finish_proxy_run(run_id: str) -> dict[str, str]:
    run = manager.get(run_id)
    if run is None:
        raise HTTPException(404, f"proxy run '{run_id}' not found")
    await run.finish()
    return {"status": "finished", "run_id": run_id}


@router.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Response:
    """OpenAI Chat Completions — injects faults when attributed to a proxy run."""
    raw = await request.body()
    try:
        parsed = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        parsed = None

    run_id = request.headers.get("x-saboteur-run-id")
    run = manager.get(run_id) if run_id else None

    # No / unknown run id, or an unparseable body → transparent passthrough.
    if run is None or not isinstance(parsed, dict):
        stream = isinstance(parsed, dict) and bool(parsed.get("stream"))
        return await inject.passthrough_chat(raw, request.headers, stream=stream)

    try:
        agent_id = int(request.headers.get("x-saboteur-agent-id", "0"))
    except (TypeError, ValueError):
        agent_id = 0

    session = run.session(agent_id)
    return await inject.inject_chat_completion(
        run, session, raw_body=raw, parsed=parsed, headers=request.headers
    )


@router.get("/v1/models")
async def models(request: Request) -> Response:
    """Passthrough the model list (some SDKs probe this on startup)."""
    status, up_headers, content = await forward.forward_nonstream(
        "models", request.headers, b"", method="GET"
    )
    return Response(
        content=content,
        status_code=status,
        media_type=up_headers.get("content-type", "application/json"),
    )
