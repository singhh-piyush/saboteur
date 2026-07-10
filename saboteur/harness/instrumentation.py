"""AgentEvent to TelemetryEvent adapter (the harness half of invariant #3).

Enriches AgentEvents into canonical TelemetryEvents and publishes them on the TelemetryBus.
"""

from __future__ import annotations

from saboteur.agents.outcomes import AgentEvent
from saboteur.telemetry.build import latency_ms_from_detail
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.schema import EventKind, TelemetryEvent

from saboteur.agents.factory import OnEvent

# map agent event kind to telemetry event kind
_KIND_MAP: dict[str, EventKind] = {
    "step_start": "step_start",
    "tool_call": "tool_call",
    "fault": "fault_injected",
    "recovery": "recovery_action",
    "terminal": "agent_done",
}


def to_telemetry(event: AgentEvent, run_id: str) -> TelemetryEvent | None:
    # enrich an agent-local event into the canonical schema
    kind = _KIND_MAP.get(event.kind)
    if kind is None:
        return None

    data = dict(event.data)
    fault: str | None = None
    recovery: str | None = None
    tokens_used: int | None = None
    latency_ms: float | None = None

    if event.kind == "fault":
        fault = data.pop("fault", None)
        detail = data.get("detail")
        if isinstance(detail, dict):
            latency_ms = latency_ms_from_detail(detail)
    elif event.kind == "recovery":
        recovery = data.pop("kind", None)
    elif event.kind == "terminal":
        tokens_used = data.get("tokens_used")

    return TelemetryEvent(
        run_id=run_id,
        agent_id=event.agent_id,
        step=event.step,
        event=kind,
        fault=fault,
        recovery=recovery,
        tokens_used=tokens_used,
        latency_ms=latency_ms,
        payload=data,
    )


def make_on_event(bus: TelemetryBus, run_id: str) -> OnEvent:
    # build the per-agent on_event callback for a run

    def _on_event(event: AgentEvent) -> None:
        try:
            telemetry = to_telemetry(event, run_id)
            if telemetry is not None:
                bus.emit(telemetry)
        except Exception:
            pass

    return _on_event
