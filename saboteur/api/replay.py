
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import JsonlWriter, read_jsonl
from saboteur.telemetry.ws import registry

router = APIRouter(prefix="/replay", tags=["replay"])

_RUNS_DIR = Path("runs")

# cap per-event delay to avoid stalling client on long gaps
_MAX_DELAY_S = 5.0


class ReplayRequest(BaseModel):
    jsonl_path: str
    speed: float = 1.0


class ReplayResponse(BaseModel):
    run_id: str


@router.post("", response_model=ReplayResponse, status_code=202)
async def start_replay(req: ReplayRequest) -> ReplayResponse:
    path = Path(req.jsonl_path)
    if path.suffix != ".jsonl":
        raise HTTPException(422, "only .jsonl files are supported")
    if not path.exists():
        raise HTTPException(404, f"file not found: {req.jsonl_path}")

    events = read_jsonl(path)
    if not events:
        raise HTTPException(422, "JSONL file is empty")

    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%S")
    run_id = f"replay-{stamp}-{uuid.uuid4().hex[:6]}"

    bus = TelemetryBus()
    bus.bind(asyncio.get_running_loop())
    registry.register(run_id, bus)

    _RUNS_DIR.mkdir(parents=True, exist_ok=True)
    writer = JsonlWriter(bus, run_id, runs_dir=_RUNS_DIR)
    writer_task = asyncio.create_task(writer.run())

    speed = req.speed

    async def _stream() -> None:
        try:
            prev_ts: datetime | None = None
            for event in events:
                if prev_ts is not None and speed > 0:
                    delta = (event.ts - prev_ts).total_seconds() / speed
                    if delta > 0:
                        await asyncio.sleep(min(delta, _MAX_DELAY_S))
                bus.emit(event.model_copy(update={"run_id": run_id}))
                prev_ts = event.ts
        finally:
            bus.close()
            try:
                await asyncio.wait_for(writer_task, timeout=10.0)
            except asyncio.TimeoutError:
                writer_task.cancel()
            registry.unregister(run_id)

    asyncio.create_task(_stream())
    return ReplayResponse(run_id=run_id)
