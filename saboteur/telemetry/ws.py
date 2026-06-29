"""WebSocket broadcaster — /ws/{run_id} replays history then streams live.

On connect:
  1. Start capturing live events from the bus (if the run is still active).
  2. Replay every event in runs/{run_id}.jsonl (the committed history).
  3. Stream live events that arrived after the last replayed event.
  4. Send a ``{"event":"__stream_complete__"}`` control frame then close with
     code 1000 / reason ``"run_finished"`` once the stream is exhausted.

Subscribing before reading the JSONL prevents any gap between replay and live.
Events that appear in both JSONL and the live queue are deduplicated by ``ts``.
A client disconnect never crashes the bus (invariant #3).

The ``__stream_complete__`` frame is a **transport-only control message**:
  - Never written to JSONL (invariant #3 — JSONL contains only TelemetryEvents).
  - Clients use it to distinguish "stream finished cleanly" from "connection
    lost unexpectedly", avoiding the tight-reconnect-loop bug on finished runs.

A 20-second server-side keepalive ping is sent for idle live connections so
they survive proxies that close stale-seeming TCP connections.

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

# How long (seconds) to wait for the next live event before sending a keepalive
# ping.  Never let a live connection time out silently on idle proxies.
_KEEPALIVE_INTERVAL_S = 20.0

# Stable identity for replay/live deduplication. Two events with the same tuple
# are treated as the same event (the JSONL copy and the live copy). We avoid a
# bare ``ts`` high-water mark: events emitted from different worker threads can
# share a microsecond timestamp or arrive slightly out of ts-order, and a
# ``ts <= last_ts`` cutoff would silently drop distinct live events.
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

# ---------------------------------------------------------------------------
# Control-frame helper (transport-only — NEVER written to JSONL)
# ---------------------------------------------------------------------------

_STREAM_COMPLETE_FRAME = json.dumps({"event": "__stream_complete__"})


async def _send_stream_complete(websocket: WebSocket) -> None:
    """Send the terminal control frame then close with 1000/run_finished.

    This frame is intentionally NOT a TelemetryEvent and must never be written
    to the JSONL log (invariant #3).  It exists solely so the frontend can
    distinguish a clean stream end from an unexpected disconnection.
    """
    try:
        await websocket.send_text(_STREAM_COMPLETE_FRAME)
        await websocket.close(code=1000, reason="run_finished")
    except Exception:
        # Client already gone — nothing to do.
        pass


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/ws/{run_id}")
async def websocket_run(websocket: WebSocket, run_id: str) -> None:
    """Replay history from JSONL then stream live events for *run_id*.

    Multiple clients may connect simultaneously. A disconnecting client never
    affects other subscribers or the bus.

    Protocol:
    - Real events are sent as ``TelemetryEvent`` JSON objects.
    - After all events have been delivered, a ``{"event":"__stream_complete__"}``
      control frame is sent and the socket is closed with code 1000.
    - For live runs, a WebSocket-level ping is sent every 20 seconds of
      inactivity so proxies do not drop the connection.
    """
    await websocket.accept()

    bus = registry.get(run_id)

    # If the control cohort is running, the chaos run's bus won't be registered yet.
    # Wait until it appears, sending keepalives so the client doesn't time out.
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
                try:
                    await websocket.send_bytes(b"")
                except Exception:
                    raise WebSocketDisconnect(code=1001)

    try:
        if bus is not None:
            # Live run: subscribe first (no gap), replay backlog, then stream.
            async with bus.subscribe() as live_events:
                replayed = await _replay_jsonl(websocket, run_id)
                await _stream_live(websocket, live_events, replayed)
        else:
            # Run already finished — replay the log then signal completion.
            await _replay_jsonl(websocket, run_id)

        await _send_stream_complete(websocket)

    except WebSocketDisconnect:
        # Client left early — normal; do not propagate.
        pass
    except Exception:
        # Any unexpected error: close cleanly without crashing the server.
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _replay_jsonl(
    websocket: WebSocket, run_id: str
) -> set[_Identity]:
    """Send all committed events to the client.

    Returns the set of replayed event identities so the live loop can skip the
    copies it already sent (and only those) — see ``_identity``.
    """
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
    """Forward live events to the client, deduplicating against the backlog.

    Sends a WebSocket ping every ``_KEEPALIVE_INTERVAL_S`` seconds of idle
    time so the connection survives proxies that aggressively close stale
    connections.  The keepalive ping is at the WebSocket framing layer and is
    transparent to the application-level event stream.
    """
    # We need a raw async iterator; the bus subscriber yields one. The param is
    # typed ``object`` to avoid leaking the bus subscriber type into the signature.
    aiter = cast("AsyncIterator[TelemetryEvent]", live_events).__aiter__()

    while True:
        try:
            event = await asyncio.wait_for(
                aiter.__anext__(),
                timeout=_KEEPALIVE_INTERVAL_S,
            )
        except StopAsyncIteration:
            # Bus closed — run finished; return so caller sends control frame.
            return
        except asyncio.TimeoutError:
            # No event in the last 20 s — send a keepalive ping and continue.
            try:
                await websocket.send_bytes(b"")  # WebSocket ping equivalent
            except Exception:
                # Client disconnected during idle wait.
                raise WebSocketDisconnect(code=1001)
            continue

        if _identity(event) in replayed:
            continue
        await websocket.send_text(event.model_dump_json())
