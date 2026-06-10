"""Telemetry — event schema, async bus, JSONL writer, and WebSocket broadcaster.

Telemetry is the source of truth (CLAUDE.md invariant #3). Every observable
action flows through TelemetryBus → JSONL writer + WebSocket broadcaster.
Scoring and the dashboard are pure functions over the resulting event stream,
so replaying runs/{run_id}.jsonl renders identically to live streaming.
"""

from .bus import TelemetryBus
from .jsonl import JsonlWriter, read_jsonl
from .schema import EventKind, TelemetryEvent
from .ws import BusRegistry, registry, router

__all__ = [
    "TelemetryBus",
    "JsonlWriter",
    "read_jsonl",
    "EventKind",
    "TelemetryEvent",
    "BusRegistry",
    "registry",
    "router",
]
