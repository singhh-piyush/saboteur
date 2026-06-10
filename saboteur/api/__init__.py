"""FastAPI application for the Saboteur orchestrator.

Routes to be added (later build steps):
  POST /runs          — start a battle-royale run
  GET  /runs/{run_id} — run status
  WS   /ws/{run_id}   — live telemetry stream
  GET  /profiles      — list available chaos profiles
  GET  /scorecard/{run_id}
  GET  /replay/{run_id}
"""

from fastapi import FastAPI

from saboteur.config import get_settings

app = FastAPI(title="Saboteur", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check — returns OK and the configured model ID."""
    return {"status": "ok", "model": get_settings().model_id}
