"""pure telemetry event builders shared across injection processes"""

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
    # generic event builder
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
    # get wall-clock delay from fault details in ms
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
