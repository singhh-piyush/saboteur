from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from saboteur.config import get_settings
from saboteur.mcp import mcp_router
from saboteur.proxy import proxy_router
from saboteur.proxy.forward import aclose_client
from saboteur.telemetry.ws import router as ws_router

from .faults import router as faults_router
from .profiles import router as profiles_router
from .replay import router as replay_router
from .runs import router as runs_router
from .targets import router as targets_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from .runs import startup_index

    startup_index()
    yield
    await aclose_client()


app = FastAPI(title="Saboteur", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)
app.include_router(profiles_router)
app.include_router(faults_router)
app.include_router(runs_router)
app.include_router(replay_router)
app.include_router(targets_router)
app.include_router(proxy_router)
app.include_router(mcp_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": get_settings().model_id}


_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
