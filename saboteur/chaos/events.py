"""Fault taxonomy, fault events, and simulated-failure exceptions.

The 8 fault types live on 3 layers (CLAUDE.md fault taxonomy):

- tool:      api_error, rate_limit, malformed, silent_lie, tool_vanish
- transport: latency, timeout
- context:   context_drop

Every injected fault is reported as a :class:`FaultEvent` through the
engine's ``on_fault`` callback so telemetry can subscribe. Faults that
manifest as exceptions all subclass :class:`ChaosFault`, which lets the
harness distinguish injected failures from real bugs.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class FaultType(enum.StrEnum):
    """The 8 fault types Saboteur can inject."""

    API_ERROR = "api_error"
    RATE_LIMIT = "rate_limit"
    MALFORMED = "malformed"
    SILENT_LIE = "silent_lie"
    TOOL_VANISH = "tool_vanish"
    LATENCY = "latency"
    TIMEOUT = "timeout"
    CONTEXT_DROP = "context_drop"


LAYER: dict[FaultType, str] = {
    FaultType.API_ERROR: "tool",
    FaultType.RATE_LIMIT: "tool",
    FaultType.MALFORMED: "tool",
    FaultType.SILENT_LIE: "tool",
    FaultType.TOOL_VANISH: "tool",
    FaultType.LATENCY: "transport",
    FaultType.TIMEOUT: "transport",
    FaultType.CONTEXT_DROP: "context",
}


@dataclass(frozen=True, slots=True)
class FaultEvent:
    """One injected fault, as reported to ``on_fault``.

    ``tool_name`` is None for context-layer faults. ``call_index`` is the
    per-agent tool-call counter at injection time (for context_drop: the
    number of tool calls made so far). ``detail`` carries fault-specific
    data, e.g. ``{"retry_after_s": 4.2}`` or ``{"original": "22.0",
    "lied": "38.5"}`` — for silent_lie this is what lets the verifier
    prove the lie.
    """

    fault: FaultType
    tool_name: str | None
    call_index: int
    agent_id: int
    detail: dict[str, Any] = field(default_factory=dict)


class ChaosFault(Exception):
    """Base class for every exception the chaos engine injects."""


class SimulatedAPIError(ChaosFault):
    """Simulated upstream HTTP 5xx from a tool's backing service."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}: simulated upstream API error")


class SimulatedRateLimit(ChaosFault):
    """Simulated HTTP 429 with a Retry-After hint."""

    def __init__(self, retry_after_s: float) -> None:
        self.retry_after_s = retry_after_s
        super().__init__(
            f"HTTP 429 Too Many Requests. Retry-After: {retry_after_s}s"
        )


class ToolVanishedError(ChaosFault):
    """The tool no longer exists (sticky for the remainder of the run)."""

    def __init__(self, tool_name: str) -> None:
        self.tool_name = tool_name
        super().__init__(f"ToolNotFound: tool '{tool_name}' does not exist")


class SimulatedTimeout(ChaosFault, TimeoutError):
    """The tool call exceeded its deadline; the tool never ran."""

    def __init__(self, timeout_after_s: float) -> None:
        self.timeout_after_s = timeout_after_s
        super().__init__(f"Tool call timed out after {timeout_after_s}s")
