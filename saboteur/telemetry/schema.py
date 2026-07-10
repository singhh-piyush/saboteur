"""telemetry event schema for event-sourced states"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

EventKind = Literal[
    "step_start",
    "tool_call",
    "fault_injected",
    "recovery_action",
    "agent_done",
    "agent_crashed",
    "run_started",
    "run_finished",
]


class TelemetryEvent(BaseModel):
    # single event schema representing one run moment

    ts: datetime = Field(default_factory=lambda: datetime.now(tz=timezone.utc))
    run_id: str
    agent_id: int
    step: int | None
    event: EventKind
    fault: str | None = None
    recovery: str | None = None
    tokens_used: int | None = None
    # wall-clock delay on latency/timeout faults in ms
    latency_ms: float | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    model_config = {"frozen": True}
