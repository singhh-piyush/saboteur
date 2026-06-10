"""WebSocket broadcaster — /ws/{run_id} replays history then streams live.

On connect:
  1. Start capturing live events from the bus (if the run is still active).
  2. Replay every event in runs/{run_id}.jsonl (the committed history).
  3. Stream live events that arrived after the last replayed event.

Subscribing before reading the JSONL prevents any gap between replay and live.
Events that appear in both JSONL and the live queue are deduplicated by ``ts``.
A client disconnect never crashes the bus (invariant #3).

Registry usage::

    # when a run starts:
    registry.register(run_id, bus)
    # when a run ends:
    registry.unregister(run_id)

    # in FastAPI app startup:
    from saboteur.telemetry.ws import router, registry
    app.include_router(router)
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .bus import TelemetryBus
from .jsonl import read_jsonl
from .schema import TelemetryEvent

_RUNS_DIR = Path("runs")

router = APIRouter()


class BusRegistry:
    """Maps run_id → active TelemetryBus. Used by the WS endpoint."""

    def __init__(self) -> None:
        self._buses: dict[str, TelemetryBus] = {}

    def register(self, run_id: str, bus: TelemetryBus) -> None:
        self._buses[run_id] = bus

    def unregister(self, run_id: str) -> None:
        self._buses.pop(run_id, None)

    def get(self, run_id: str) -> TelemetryBus | None:
        return self._buses.get(run_id)


registry = BusRegistry()


@router.websocket("/ws/{run_id}")
async def websocket_run(websocket: WebSocket, run_id: str) -> None:
    """Replay history from JSONL then stream live events for *run_id*.

    Multiple clients may connect simultaneously. A disconnecting client never
    affects other subscribers or the bus.
    """
    await websocket.accept()

    bus = registry.get(run_id)

    try:
        if bus is not None:
            async with bus.subscribe() as live_events:
                last_ts = await _replay_jsonl(websocket, run_id)
                async for event in live_events:
                    if last_ts is not None and event.ts <= last_ts:
                        continue
                    await websocket.send_text(event.model_dump_json())
        else:
            # Run already finished — just replay the log.
            await _replay_jsonl(websocket, run_id)
    except WebSocketDisconnect:
        pass
    except Exception:
        # Any other error: close cleanly without propagating.
        try:
            await websocket.close()
        except Exception:
            pass


async def _replay_jsonl(
    websocket: WebSocket, run_id: str
) -> datetime | None:
    """Send all committed events to the client. Returns the latest ts seen."""
    path = _RUNS_DIR / f"{run_id}.jsonl"
    if not path.exists():
        return None

    last_ts: datetime | None = None
    for event in read_jsonl(path):
        await websocket.send_text(event.model_dump_json())
        if last_ts is None or event.ts > last_ts:
            last_ts = event.ts
    return last_ts
