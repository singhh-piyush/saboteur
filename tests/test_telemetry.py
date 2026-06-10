"""Acceptance tests for the telemetry package (invariant #3).

Three scenarios:
  1. Thread safety — events emitted from a worker thread arrive at an async
     subscriber in order.
  2. JSONL writer — events are flushed per-event; the file is complete and
     valid after the run.
  3. WebSocket endpoint — a test client receives the JSONL backlog followed
     by live events, with no duplicates and correct order.
"""

from __future__ import annotations

import asyncio
import json
from datetime import timezone
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import JsonlWriter, read_jsonl
from saboteur.telemetry.schema import TelemetryEvent
from saboteur.telemetry.ws import BusRegistry, router

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RUN_ID = "test-run-001"


def _event(run_id: str = RUN_ID, agent_id: int = 0, step: int = 1) -> TelemetryEvent:
    return TelemetryEvent(
        run_id=run_id,
        agent_id=agent_id,
        step=step,
        event="step_start",
    )


def _bound_bus() -> TelemetryBus:
    bus = TelemetryBus()
    bus.bind(asyncio.get_event_loop())
    return bus


# ---------------------------------------------------------------------------
# 1. Thread safety
# ---------------------------------------------------------------------------

async def test_thread_emit_arrives_in_order() -> None:
    """Events emitted from worker threads arrive at the async subscriber in order."""
    bus = _bound_bus()
    n = 20

    async def collect() -> list[TelemetryEvent]:
        received: list[TelemetryEvent] = []
        async with bus.subscribe() as events:
            async for ev in events:
                received.append(ev)
                if len(received) == n:
                    break
        return received

    async def emit_from_thread() -> None:
        def _worker() -> None:
            for i in range(n):
                bus.emit(_event(step=i))

        await asyncio.to_thread(_worker)

    collector = asyncio.create_task(collect())
    await emit_from_thread()
    received = await collector

    assert len(received) == n
    for i, ev in enumerate(received):
        assert ev.step == i


async def test_subscriber_stops_after_close() -> None:
    """Bus.close() terminates all subscriber iterators."""
    bus = _bound_bus()

    received: list[TelemetryEvent] = []

    async def collect() -> None:
        async with bus.subscribe() as events:
            async for ev in events:
                received.append(ev)

    task = asyncio.create_task(collect())

    bus.emit(_event(step=1))
    bus.emit(_event(step=2))
    # Yield to let the event loop dispatch the emitted events.
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    bus.close()
    await asyncio.wait_for(task, timeout=1.0)

    assert len(received) == 2


async def test_multiple_subscribers_each_receive_all_events() -> None:
    bus = _bound_bus()
    n = 5

    results: list[list[TelemetryEvent]] = []

    async def sub() -> None:
        got: list[TelemetryEvent] = []
        async with bus.subscribe() as events:
            async for ev in events:
                got.append(ev)
        results.append(got)

    tasks = [asyncio.create_task(sub()) for _ in range(3)]
    await asyncio.sleep(0)  # let all subscribers register

    for i in range(n):
        bus.emit(_event(step=i))

    await asyncio.sleep(0)
    await asyncio.sleep(0)
    bus.close()
    await asyncio.gather(*tasks)

    assert len(results) == 3
    for got in results:
        assert len(got) == n


async def test_disconnect_subscriber_does_not_affect_others() -> None:
    """Exiting one subscriber context must not starve other subscribers."""
    bus = _bound_bus()

    received_b: list[TelemetryEvent] = []

    async def short_sub() -> None:
        async with bus.subscribe() as events:
            # read one event then exit early
            async for _ in events:
                break

    async def long_sub() -> None:
        async with bus.subscribe() as events:
            async for ev in events:
                received_b.append(ev)

    short_task = asyncio.create_task(short_sub())
    long_task = asyncio.create_task(long_sub())
    await asyncio.sleep(0)

    for i in range(3):
        bus.emit(_event(step=i))

    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await short_task

    bus.close()
    await asyncio.wait_for(long_task, timeout=1.0)

    assert len(received_b) == 3


# ---------------------------------------------------------------------------
# 2. JSONL writer
# ---------------------------------------------------------------------------

async def test_jsonl_written_and_flushed(tmp_path: Path) -> None:
    """Writer produces a valid JSONL file with one line per event."""
    bus = _bound_bus()
    writer = JsonlWriter(bus, RUN_ID, runs_dir=tmp_path)
    write_task = asyncio.create_task(writer.run())

    n = 5
    for i in range(n):
        bus.emit(_event(step=i))

    await asyncio.sleep(0)
    await asyncio.sleep(0)
    bus.close()
    await asyncio.wait_for(write_task, timeout=2.0)

    log = tmp_path / f"{RUN_ID}.jsonl"
    assert log.exists()
    lines = [l for l in log.read_text().splitlines() if l.strip()]
    assert len(lines) == n
    for i, line in enumerate(lines):
        ev = TelemetryEvent.model_validate_json(line)
        assert ev.step == i
        assert ev.run_id == RUN_ID


async def test_jsonl_survives_partial_run(tmp_path: Path) -> None:
    """Events already written are readable even before the bus closes."""
    bus = _bound_bus()
    writer = JsonlWriter(bus, RUN_ID, runs_dir=tmp_path)
    write_task = asyncio.create_task(writer.run())

    bus.emit(_event(step=1))
    bus.emit(_event(step=2))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    # Read the file while the run is still "in progress".
    log = tmp_path / f"{RUN_ID}.jsonl"
    events = read_jsonl(log)
    assert len(events) >= 1  # at least one has been flushed

    bus.close()
    await asyncio.wait_for(write_task, timeout=2.0)


async def test_read_jsonl_round_trips(tmp_path: Path) -> None:
    """read_jsonl parses every field correctly."""
    bus = _bound_bus()
    original = TelemetryEvent(
        run_id="r1",
        agent_id=3,
        step=7,
        event="fault_injected",
        fault="api_error",
        latency_ms=42.5,
        payload={"detail": "HTTP 500"},
    )
    writer = JsonlWriter(bus, "r1", runs_dir=tmp_path)
    write_task = asyncio.create_task(writer.run())

    bus.emit(original)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    bus.close()
    await asyncio.wait_for(write_task, timeout=2.0)

    [parsed] = read_jsonl(tmp_path / "r1.jsonl")
    assert parsed.run_id == original.run_id
    assert parsed.agent_id == original.agent_id
    assert parsed.step == original.step
    assert parsed.event == original.event
    assert parsed.fault == original.fault
    assert parsed.latency_ms == original.latency_ms
    assert parsed.payload == original.payload
    # Timestamps survive the round-trip (UTC-aware).
    assert parsed.ts.tzinfo is not None


# ---------------------------------------------------------------------------
# 3. WebSocket endpoint
# ---------------------------------------------------------------------------

def _make_app(reg: BusRegistry):
    """Build a minimal FastAPI app with the WS router wired to *reg*."""
    from fastapi import FastAPI
    from saboteur.telemetry import ws as ws_mod

    app = FastAPI()

    # Patch the module-level registry so the router uses our test instance.
    original = ws_mod.registry
    ws_mod.registry = reg
    app.include_router(router)

    # Restore after the test (done in the fixture below).
    app._test_original_registry = original  # type: ignore[attr-defined]
    return app


@pytest.fixture()
def tmp_runs(tmp_path: Path, monkeypatch):
    """Point ws._RUNS_DIR at a temp directory for the duration of the test."""
    import saboteur.telemetry.ws as ws_mod

    monkeypatch.setattr(ws_mod, "_RUNS_DIR", tmp_path)
    return tmp_path


def test_ws_replay_only(tmp_runs: Path) -> None:
    """A completed run: client receives exactly the JSONL backlog."""
    import saboteur.telemetry.ws as ws_mod

    run_id = "ws-test-replay"
    # Write two events to JSONL manually.
    events = [_event(run_id=run_id, step=i) for i in range(2)]
    log = tmp_runs / f"{run_id}.jsonl"
    with log.open("w") as f:
        for ev in events:
            f.write(ev.model_dump_json() + "\n")

    reg = BusRegistry()  # no live bus registered → replay only
    app = _make_app(reg)

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/{run_id}") as ws:
            received = [ws.receive_json() for _ in range(2)]

    assert len(received) == 2
    assert received[0]["step"] == 0
    assert received[1]["step"] == 1


def test_ws_backlog_then_live(tmp_runs: Path) -> None:
    """Active run: client receives JSONL backlog then a live event.

    TestClient (Starlette) runs the ASGI app in a background thread with its
    own anyio event loop. We capture that loop from a FastAPI lifespan so that
    bus.emit() can call_soon_threadsafe onto it from the main thread.
    """
    import saboteur.telemetry.ws as ws_mod
    from contextlib import asynccontextmanager
    from fastapi import FastAPI

    run_id = "ws-test-live"

    # Seed one historical event in JSONL.
    historical = _event(run_id=run_id, step=0)
    (tmp_runs / f"{run_id}.jsonl").write_text(historical.model_dump_json() + "\n")

    bus = TelemetryBus()
    reg = BusRegistry()
    reg.register(run_id, bus)

    original_registry = ws_mod.registry
    ws_mod.registry = reg
    try:
        @asynccontextmanager
        async def lifespan(app):
            # Runs inside the anyio background thread — this IS the event loop
            # we need for call_soon_threadsafe to dispatch onto subscribers.
            bus.bind(asyncio.get_running_loop())
            yield

        app = FastAPI(lifespan=lifespan)
        app.include_router(router)

        with TestClient(app) as client:
            # Lifespan has run; bus is now bound to the anyio loop.
            with client.websocket_connect(f"/ws/{run_id}") as ws:
                # 1. Receive the backlog (historical) event.
                backlog = ws.receive_json()

                # 2. Emit a live event from the main thread. call_soon_threadsafe
                #    schedules dispatch on the anyio background loop, which then
                #    puts it in the subscriber queue so the WS handler sends it.
                bus.emit(_event(run_id=run_id, step=1))

                # 3. Receive the live event.
                live = ws.receive_json()

    finally:
        ws_mod.registry = original_registry

    assert backlog["step"] == 0
    assert live["step"] == 1
