"""websocket broadcaster for run streaming

replays jsonl history then streams live events.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .bus import TelemetryBus
from .jsonl import read_jsonl
from .schema import TelemetryEvent

_RUNS_DIR = Path("runs")

# keepalive ping interval in seconds
_KEEPALIVE_INTERVAL_S = 20.0

# stable identity for event deduplication
_Identity = tuple[str, int, int | None, str, str | None, str | None]


def _identity(event: TelemetryEvent) -> _Identity:
    return (
        event.ts.isoformat(),
        event.agent_id,
        event.step,
        event.event,
        event.fault,
        event.recovery,
    )


router = APIRouter()


class BusRegistry:
    # active telemetry buses mapped by run_id

    def __init__(self) -> None:
        self._buses: dict[str, TelemetryBus] = {}

    def register(self, run_id: str, bus: TelemetryBus) -> None:
        self._buses[run_id] = bus

    def unregister(self, run_id: str) -> None:
        self._buses.pop(run_id, None)

    def get(self, run_id: str) -> TelemetryBus | None:
        return self._buses.get(run_id)


registry = BusRegistry()

_STREAM_COMPLETE_FRAME = json.dumps({"event": "__stream_complete__"})
_KEEPALIVE_FRAME = json.dumps({"event": "__keepalive__"})


async def _send_keepalive(websocket: WebSocket) -> None:
    # send transport-only keepalive control frame
    try:
        await websocket.send_text(_KEEPALIVE_FRAME)
    except Exception:
        raise WebSocketDisconnect(code=1001)


async def _send_stream_complete(websocket: WebSocket) -> None:
    # send transport-only stream complete control frame
    try:
        await websocket.send_text(_STREAM_COMPLETE_FRAME)
        await websocket.close(code=1000, reason="run_finished")
    except Exception:
        # Client already gone — nothing to do.
        pass


@router.websocket("/ws/{run_id}")
async def websocket_run(websocket: WebSocket, run_id: str) -> None:
    # websocket handler to stream run events
    await websocket.accept()

    bus = registry.get(run_id)

    # wait for bus to be registered if control cohort is still running
    from saboteur.api.state import run_registry, RunStatus
    state = run_registry.get(run_id)
    if bus is None and state is not None and state.status in (RunStatus.PENDING, RunStatus.RUNNING):
        ticks = 0
        while bus is None:
            await asyncio.sleep(0.5)
            bus = registry.get(run_id)
            state = run_registry.get(run_id)
            if state is None or state.status not in (RunStatus.PENDING, RunStatus.RUNNING):
                break
            
            ticks += 1
            if ticks % 10 == 0:
                await _send_keepalive(websocket)

    try:
        if bus is not None:
            async with bus.subscribe() as live_events:
                replayed = await _replay_jsonl(websocket, run_id)
                await _stream_live(websocket, live_events, replayed)
        else:
            await _replay_jsonl(websocket, run_id)

        await _send_stream_complete(websocket)

    except WebSocketDisconnect:
        pass
    except Exception:
        # close on unexpected disconnect
        try:
            await websocket.close()
        except Exception:
            pass


async def _replay_jsonl(
    websocket: WebSocket, run_id: str
) -> set[_Identity]:
    # replay jsonl file and return replayed event identities
    path = _RUNS_DIR / f"{run_id}.jsonl"
    if not path.exists():
        return set()

    seen: set[_Identity] = set()
    for event in read_jsonl(path):
        await websocket.send_text(event.model_dump_json())
        seen.add(_identity(event))
    return seen


async def _stream_live(
    websocket: WebSocket,
    live_events: object,  # AsyncIterator[TelemetryEvent]
    replayed: set[_Identity],
) -> None:
    # stream live events to client, deduplicating against replayed
    # use raw async iterator of events
    aiter = cast("AsyncIterator[TelemetryEvent]", live_events).__aiter__()

    while True:
        try:
            event = await asyncio.wait_for(
                aiter.__anext__(),
                timeout=_KEEPALIVE_INTERVAL_S,
            )
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            await _send_keepalive(websocket)
            continue

        if _identity(event) in replayed:
            continue
        await websocket.send_text(event.model_dump_json())
