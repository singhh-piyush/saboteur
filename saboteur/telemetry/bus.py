"""in-process telemetry event bus

emit is thread-safe; subscribers consume async iterators on the event loop.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from .schema import TelemetryEvent

_SENTINEL = object()


class TelemetryBus:
    # per-run event bus with thread-safe emit

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        # queues are only accessed on the event loop
        self._queues: list[asyncio.Queue[TelemetryEvent | object]] = []
        self._closed = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        # bind to running event loop before emitting events
        self._loop = loop

    def close(self) -> None:
        # close bus and signal subscribers
        if self._loop is None or self._closed:
            return
        self._closed = True
        self._loop.call_soon_threadsafe(self._send_sentinel)

    def _send_sentinel(self) -> None:
        for q in list(self._queues):
            q.put_nowait(_SENTINEL)

    def emit(self, event: TelemetryEvent) -> None:
        # publish event to subscribers; safe to call from any thread
        if self._loop is None or self._closed:
            return
        self._loop.call_soon_threadsafe(self._dispatch, event)

    def _dispatch(self, event: TelemetryEvent) -> None:
        for q in list(self._queues):
            q.put_nowait(event)

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[AsyncIterator[TelemetryEvent]]:
        # yield async iterator of events
        q: asyncio.Queue[TelemetryEvent | object] = asyncio.Queue()
        self._queues.append(q)
        try:
            yield _queue_iter(q)
        finally:
            # remove queue and queue sentinel
            try:
                self._queues.remove(q)
            except ValueError:
                pass
            await q.put(_SENTINEL)


async def _queue_iter(
    q: asyncio.Queue[TelemetryEvent | object],
) -> AsyncIterator[TelemetryEvent]:
    # drain queue until sentinel
    while True:
        item = await q.get()
        if item is _SENTINEL:
            return
        yield item  # type: ignore[misc]
