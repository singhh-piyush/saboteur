"""TelemetryEvent — the single event schema for Saboteur (invariant #3).

Every observable action (step, tool call, fault, recovery, run lifecycle)
is encoded as a TelemetryEvent. Scoring and the dashboard are pure functions
over a stream of these; replaying the JSONL log must render identically to
live streaming.
"""

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
    """One observable moment in a Saboteur run.

    All fields are required except ``fault``, ``recovery``, ``tokens_used``,
    and ``latency_ms``, which are only meaningful for specific event kinds.
    ``payload`` carries event-kind-specific extras so the core schema stays
    stable as new event types are added.
    """

    ts: datetime = Field(default_factory=lambda: datetime.now(tz=timezone.utc))
    run_id: str
    agent_id: int
    step: int | None
    event: EventKind
    fault: str | None = None
    recovery: str | None = None
    tokens_used: int | None = None
    latency_ms: float | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    model_config = {"frozen": True}
