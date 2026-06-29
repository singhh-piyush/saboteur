"""Telemetry sinks for the MCP shim.

The shim runs out-of-process from the dashboard (the MCP client launches it as a
stdio ``command``), so it cannot touch the in-process telemetry bus directly.
``HttpEmitter`` POSTs each :class:`TelemetryEvent` to the dashboard's ingest
endpoint (``POST /mcp/runs/{id}/events``), where the run re-emits it on the bus →
JSONL + WebSocket + grid. Posts run on a single background thread so the relay's
event loop never blocks on the network and event order is preserved; failures are
swallowed (telemetry must never break the proxied tool call — invariant #3).

``ListEmitter`` is the in-process test sink (and the offline/no-dashboard mode):
it just appends events.
"""

from __future__ import annotations

import urllib.request
from concurrent.futures import ThreadPoolExecutor

from saboteur.telemetry.schema import TelemetryEvent


class ListEmitter:
    """Collect events in a list (tests, and offline shim runs)."""

    def __init__(self) -> None:
        self.events: list[TelemetryEvent] = []

    def emit(self, event: TelemetryEvent) -> None:
        self.events.append(event)


class HttpEmitter:
    """POST events to the dashboard ingest endpoint, off the event loop."""

    def __init__(self, run_id: str, base_url: str, *, timeout: float = 2.0) -> None:
        self.url = f"{base_url.rstrip('/')}/mcp/runs/{run_id}/events"
        self.timeout = timeout
        # One worker ⇒ posts stay in submission order; daemon so process exit is
        # never blocked by an in-flight post.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mcp-telemetry")

    def emit(self, event: TelemetryEvent) -> None:
        body = event.model_dump_json().encode("utf-8")
        self._pool.submit(self._post, body)

    def _post(self, body: bytes) -> None:
        try:
            req = urllib.request.Request(
                self.url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp.read()
        except Exception:
            pass  # best-effort: never let telemetry break the relay

    def close(self) -> None:
        self._pool.shutdown(wait=True)
