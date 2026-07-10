
from __future__ import annotations

import urllib.request
from concurrent.futures import ThreadPoolExecutor

from saboteur.telemetry.schema import TelemetryEvent


class ListEmitter:

    def __init__(self) -> None:
        self.events: list[TelemetryEvent] = []

    def emit(self, event: TelemetryEvent) -> None:
        self.events.append(event)


class HttpEmitter:

    def __init__(self, run_id: str, base_url: str, *, timeout: float = 2.0) -> None:
        self.url = f"{base_url.rstrip('/')}/mcp/runs/{run_id}/events"
        self.timeout = timeout
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
            pass

    def close(self) -> None:
        self._pool.shutdown(wait=True)
