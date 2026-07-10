"""telemetry event schema, bus, and streaming utilities

events flow through TelemetryBus to disk and websockets.
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
