"""TelemetryBus — async-safe in-process pub/sub for telemetry events.

Agents run in worker threads (asyncio.to_thread), so emit() is called from
threads. Subscribers live on the event loop and async-iterate over their queue.
The bus is instantiated once per run; all mutable state is instance-local so
concurrent runs don't share anything (invariant #2).

Usage::

    bus = TelemetryBus()
    bus.bind(asyncio.get_event_loop())   # once, from the event loop

    # from a worker thread:
    bus.emit(event)

    # from async code:
    async with bus.subscribe() as events:
        async for ev in events:
            ...

    # when the run is done:
    bus.close()
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Generator

from .schema import TelemetryEvent

_SENTINEL = object()


class TelemetryBus:
    """Per-run event bus. Thread-safe emit; async subscriber iteration."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        # All queue access happens on the event loop, so no extra lock needed.
        self._queues: list[asyncio.Queue[TelemetryEvent | object]] = []
        self._closed = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind to the running event loop. Must be called before any emit."""
        self._loop = loop

    def close(self) -> None:
        """Signal all subscribers that the stream is finished.

        Safe to call from any thread. Idempotent.
        """
        if self._loop is None or self._closed:
            return
        self._closed = True
        self._loop.call_soon_threadsafe(self._send_sentinel)

    def _send_sentinel(self) -> None:
        for q in list(self._queues):
            q.put_nowait(_SENTINEL)

    # ------------------------------------------------------------------
    # Emit (thread-safe)
    # ------------------------------------------------------------------

    def emit(self, event: TelemetryEvent) -> None:
        """Publish an event to all current subscribers.

        Safe to call from any thread. Silently drops the event if the bus
        is not bound or has been closed — telemetry must never crash an agent
        (invariant #3).
        """
        if self._loop is None or self._closed:
            return
        self._loop.call_soon_threadsafe(self._dispatch, event)

    def _dispatch(self, event: TelemetryEvent) -> None:
        """Runs on the event loop thread; no lock needed."""
        for q in list(self._queues):
            q.put_nowait(event)

    # ------------------------------------------------------------------
    # Subscribe (async context manager)
    # ------------------------------------------------------------------

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[AsyncIterator[TelemetryEvent]]:
        """Async context manager that yields an async iterator of events.

        The iterator stops when the bus is closed or the context exits.
        A disconnecting subscriber never affects other subscribers or the bus.

        Example::

            async with bus.subscribe() as events:
                async for ev in events:
                    process(ev)
        """
        q: asyncio.Queue[TelemetryEvent | object] = asyncio.Queue()
        self._queues.append(q)
        try:
            yield _queue_iter(q)
        finally:
            # Remove before draining so no more items are enqueued.
            try:
                self._queues.remove(q)
            except ValueError:
                pass
            # Put a sentinel so the iterator stops if still running.
            await q.put(_SENTINEL)


async def _queue_iter(
    q: asyncio.Queue[TelemetryEvent | object],
) -> AsyncIterator[TelemetryEvent]:
    """Drain a queue, stopping at the first sentinel."""
    while True:
        item = await q.get()
        if item is _SENTINEL:
            return
        yield item  # type: ignore[misc]
