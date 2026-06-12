"""AgentEvent → TelemetryEvent adapter (the harness half of invariant #3).

The agent layer emits :class:`~saboteur.agents.outcomes.AgentEvent` — agent-
local, no ``run_id``/``ts``. The harness enriches each one into the canonical
:class:`~saboteur.telemetry.schema.TelemetryEvent` and publishes it on the
run's :class:`~saboteur.telemetry.bus.TelemetryBus`. ``bus.emit`` is already
thread-safe, which matters because the agent callbacks fire inside
``asyncio.to_thread`` worker threads.

The adapter is total: an unknown event kind is dropped (returns ``None``),
and the bus callback swallows every exception — telemetry must never crash
an agent.
"""

from __future__ import annotations

from saboteur.agents.outcomes import AgentEvent
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.schema import EventKind, TelemetryEvent

from saboteur.agents.factory import OnEvent

# AgentEvent.kind → canonical EventKind.
_KIND_MAP: dict[str, EventKind] = {
    "step_start": "step_start",
    "tool_call": "tool_call",
    "fault": "fault_injected",
    "recovery": "recovery_action",
    "terminal": "agent_done",
}


def to_telemetry(event: AgentEvent, run_id: str) -> TelemetryEvent | None:
    """Enrich an agent-local event into the canonical schema.

    Lifts the fields the scorecard keys on (``fault``, ``recovery``,
    ``tokens_used``) out of the payload; everything else rides along in
    ``payload``. Returns ``None`` for unknown kinds so callers can drop them.
    """
    kind = _KIND_MAP.get(event.kind)
    if kind is None:
        return None

    data = dict(event.data)
    fault: str | None = None
    recovery: str | None = None
    tokens_used: int | None = None

    if event.kind == "fault":
        fault = data.pop("fault", None)
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
        payload=data,
    )


def make_on_event(bus: TelemetryBus, run_id: str) -> OnEvent:
    """Build the per-agent ``on_event`` callback for a run.

    Safe to call from worker threads; never raises into the agent loop.
    """

    def _on_event(event: AgentEvent) -> None:
        try:
            telemetry = to_telemetry(event, run_id)
            if telemetry is not None:
                bus.emit(telemetry)
        except Exception:
            pass

    return _on_event
