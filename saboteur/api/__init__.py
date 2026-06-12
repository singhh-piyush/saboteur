"""FastAPI application for the Saboteur orchestrator."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from saboteur.config import get_settings
from saboteur.telemetry.ws import router as ws_router

from .profiles import router as profiles_router
from .replay import router as replay_router
from .runs import router as runs_router

app = FastAPI(title="Saboteur", version="0.1.0")

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


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check — returns OK and the configured model ID."""
    return {"status": "ok", "model": get_settings().model_id}


# Serve the built frontend if present (production / demo mode).
_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
