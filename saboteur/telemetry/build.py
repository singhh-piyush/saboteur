"""Pure :class:`TelemetryEvent` constructors, shared across injection surfaces.

These are *pure* — given the same arguments they return the same event, with no
I/O and no side effects. They exist so every surface that produces telemetry (the
wire proxy's :class:`~saboteur.proxy.session.ProxyRun`, and the out-of-process MCP
shim in :mod:`saboteur.mcp`) emits the **byte-identical event shape** for each
kind, so the dashboard / scoring / replay render the same regardless of which
surface produced the stream (invariant #3). Keeping the shapes here, instead of
duplicated inline, means they can never drift between surfaces.

The MCP shim builds these in its own process and POSTs them to the dashboard's
ingest endpoint; ``ProxyRun.emit_*`` build the same events and emit them straight
to the in-process bus.
"""

from __future__ import annotations

from typing import Any

from .schema import EventKind, TelemetryEvent


def event(
    run_id: str,
    agent_id: int,
    step: int | None,
    kind: EventKind,
    *,
    fault: str | None = None,
    recovery: str | None = None,
    tokens_used: int | None = None,
    latency_ms: float | None = None,
    payload: dict[str, Any] | None = None,
) -> TelemetryEvent:
    """The generic constructor every other builder delegates to."""
    return TelemetryEvent(
        run_id=run_id,
        agent_id=agent_id,
        step=step,
        event=kind,
        fault=fault,
        recovery=recovery,
        tokens_used=tokens_used,
        latency_ms=latency_ms,
        payload=payload or {},
    )


def latency_ms_from_detail(detail: dict[str, Any]) -> float | None:
    """The injected wall-clock delay of a latency/timeout fault, in ms.

    Lifted onto ``fault_injected`` events so the schema's ``latency_ms`` field
    is populated where the data exists; other fault kinds leave it null.
    """
    for key in ("delay_s", "timeout_after_s"):
        value = detail.get(key)
        if isinstance(value, (int, float)):
            return float(value) * 1000.0
    return None


def run_started_event(
    run_id: str, profile: str, seed: int, n_agents: int
) -> TelemetryEvent:
    return event(
        run_id,
        -1,
        None,
        "run_started",
        payload={"profile": profile, "seed": seed, "n_agents": n_agents},
    )


def run_finished_event(
    run_id: str, n_agents: int, outcomes: dict[str, int]
) -> TelemetryEvent:
    return event(
        run_id,
        -1,
        None,
        "run_finished",
        payload={"n_agents": n_agents, "outcomes": outcomes},
    )


def step_start_event(run_id: str, agent_id: int, step: int) -> TelemetryEvent:
    return event(run_id, agent_id, step, "step_start")


def tool_call_event(
    run_id: str,
    agent_id: int,
    step: int,
    tool: str | None,
    arguments: Any,
    *,
    sabotaged: bool,
    fault_types: list[str],
    errored: bool,
) -> TelemetryEvent:
    return event(
        run_id,
        agent_id,
        step,
        "tool_call",
        payload={
            "tool": tool,
            "arguments": arguments,
            "sabotaged": sabotaged,
            "fault_types": fault_types,
            "errored": errored,
        },
    )


def fault_event(
    run_id: str,
    agent_id: int,
    step: int,
    fault: str,
    *,
    tool: str | None,
    detail: dict[str, Any],
) -> TelemetryEvent:
    return event(
        run_id,
        agent_id,
        step,
        "fault_injected",
        fault=fault,
        latency_ms=latency_ms_from_detail(detail),
        payload={"tool": tool, "call_index": step, "detail": detail},
    )


def recovery_event(
    run_id: str, agent_id: int, step: int, kind: str, after_fault: str
) -> TelemetryEvent:
    return event(
        run_id,
        agent_id,
        step,
        "recovery_action",
        recovery=kind,
        payload={"kind": kind, "after_fault": after_fault},
    )
