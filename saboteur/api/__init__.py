"""FastAPI application for the Saboteur orchestrator."""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from saboteur.config import get_settings
from saboteur.proxy import proxy_router
from saboteur.proxy.forward import aclose_client
from saboteur.telemetry.ws import router as ws_router

from .profiles import router as profiles_router
from .replay import router as replay_router
from .runs import router as runs_router
from .targets import router as targets_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """App lifespan — close the proxy's shared upstream client on shutdown."""
    yield
    await aclose_client()


app = FastAPI(title="Saboteur", version="0.1.0", lifespan=lifespan)

# CORS — open for local Vite dev server and preview build.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)
app.include_router(profiles_router)
app.include_router(runs_router)
app.include_router(replay_router)
app.include_router(targets_router)
# The wire proxy: /v1/chat/completions + /proxy/* on the same app/port, so it
# shares the in-process ws.registry + runs/ dir and renders live on the grid.
app.include_router(proxy_router)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check — returns OK and the configured model ID."""
    return {"status": "ok", "model": get_settings().model_id}


# Serve the built frontend if present (production / demo mode).
_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
