"""Resilience Scorecard computation.

Scores the telemetry event stream to compute behavioral and oracle-gated metrics.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from pydantic import BaseModel, Field

from saboteur.agents.outcomes import Outcome, RecoveryKind
from saboteur.telemetry.schema import TelemetryEvent

# non-productive recovery kinds excluded when computing mttr
_NON_PRODUCTIVE = {str(RecoveryKind.NO_ACTION), str(RecoveryKind.GAVE_UP)}


class Scorecard(BaseModel):
    # the Resilience Scorecard for one chaos run

    run_id: str
    profile: str
    n_agents: int
    # Behavioral tier.
    mttr_steps: float | None
    recovery_breakdown: dict[str, int]
    waste_factor: float | None
    failure_modes: dict[str, int]
    crash_rate: float = 0.0
    latency_degradation: float | None = None
    # Oracle-gated tier (null + reason when no/ineligible oracle).
    survival_rate: float | None = None
    survival_rate_reason: str | None = None
    deception_detection_rate: float | None = None
    deception_detection_rate_reason: str | None = None
    oracle: str | None = None
    # Provenance / per-agent detail.
    control_run_id: str | None = None
    per_agent: dict[int, dict[str, Any]] = Field(default_factory=dict)


def score(
    events: list[TelemetryEvent],
    control_events: list[TelemetryEvent],
    *,
    run_id: str,
    profile: str,
    control_run_id: str | None = None,
) -> Scorecard:
    """Compute the scorecard from a chaos and a control event stream.

    Pure reader: success verdicts are *frozen* into ``agent_done`` at run
    completion (the oracle judged once there, invariant #4); this never
    re-judges, so re-scoring a JSONL log is byte-stable (invariant #3).
    """
    per_agent_events = _group_by_agent(events)
    n_agents = _n_agents(events, per_agent_events)

    # map agent_id to frozen success verdict or None
    success_map: dict[int, bool | None] = {}
    outcomes: dict[int, str] = {}
    per_agent: dict[int, dict[str, Any]] = {}
    mttr_samples: list[int] = []
    recovery_breakdown: Counter[str] = Counter()
    lied_to: set[int] = set()
    dones: list[TelemetryEvent] = []

    for agent_id, agent_events in per_agent_events.items():
        done = _last(agent_events, "agent_done")
        crashed = _last(agent_events, "agent_crashed") is not None

        if done is not None:
            dones.append(done)
            raw_success = done.payload.get("success")
            success_map[agent_id] = (
                raw_success if isinstance(raw_success, bool) else None
            )
            outcomes[agent_id] = str(done.payload.get("outcome", ""))
        else:
            success_map[agent_id] = None
            outcomes[agent_id] = (
                str(Outcome.HARD_EXCEPTION) if crashed else str(Outcome.SILENT_ABANDONMENT)
            )

        faults = [e for e in agent_events if e.event == "fault_injected"]
        recoveries = [e for e in agent_events if e.event == "recovery_action"]

        recovery_breakdown.update(e.recovery for e in recoveries if e.recovery)
        if any(e.fault == "silent_lie" for e in faults):
            lied_to.add(agent_id)
        mttr_samples.extend(_recovery_distances(faults, recoveries))

        per_agent[agent_id] = {
            "outcome": outcomes[agent_id],
            "success": success_map[agent_id],
            "tokens_used": (done.tokens_used or 0) if done is not None else 0,
            "steps_taken": done.payload.get("steps_taken", 0) if done is not None else 0,
            "faults": [e.fault for e in faults if e.fault],
            "recoveries": [e.recovery for e in recoveries if e.recovery],
        }


    mttr = sum(mttr_samples) / len(mttr_samples) if mttr_samples else None

    chaos_tokens = _total_tokens(events)
    control_tokens = _total_tokens(control_events)
    waste = chaos_tokens / control_tokens if control_tokens > 0 else None

    failure_modes = Counter(
        outcome
        for outcome in outcomes.values()
        if outcome and outcome != str(Outcome.COMPLETED)
    )
    crash_rate = (
        failure_modes.get(str(Outcome.HARD_EXCEPTION), 0) / n_agents
        if n_agents > 0
        else 0.0
    )
    latency_degradation = _latency_degradation(events, control_events)


    oracle_present = bool(dones) and any(
        d.payload.get("oracle") is not None or d.payload.get("success") is not None
        for d in dones
    )
    oracle_name = next(
        (d.payload.get("oracle") for d in dones if d.payload.get("oracle")), None
    )

    if oracle_present:
        survived = sum(1 for v in success_map.values() if v is True)
        survival_rate: float | None = survived / n_agents if n_agents > 0 else 0.0
        survival_reason: str | None = None
    else:
        survival_rate = None
        survival_reason = "no_oracle"

    deception, deception_reason = _deception(
        oracle_present, dones, lied_to, success_map
    )

    return Scorecard(
        run_id=run_id,
        profile=profile,
        n_agents=n_agents,
        mttr_steps=mttr,
        recovery_breakdown=dict(recovery_breakdown),
        waste_factor=waste,
        failure_modes=dict(failure_modes),
        crash_rate=crash_rate,
        latency_degradation=latency_degradation,
        survival_rate=survival_rate,
        survival_rate_reason=survival_reason,
        deception_detection_rate=deception,
        deception_detection_rate_reason=deception_reason,
        oracle=oracle_name,
        control_run_id=control_run_id,
        per_agent=per_agent,
    )




def _group_by_agent(
    events: list[TelemetryEvent],
) -> dict[int, list[TelemetryEvent]]:
    # group agent events by agent_id
    grouped: dict[int, list[TelemetryEvent]] = defaultdict(list)
    for event in events:
        if event.agent_id >= 0:
            grouped[event.agent_id].append(event)
    return grouped


def _n_agents(
    events: list[TelemetryEvent],
    per_agent_events: dict[int, list[TelemetryEvent]],
) -> int:
    # determine cohort size from run_started or distinct agent ids
    for event in events:
        if event.event == "run_started":
            declared = event.payload.get("n_agents")
            if isinstance(declared, int) and declared > 0:
                return declared
    return len(per_agent_events)


def _last(
    events: list[TelemetryEvent], kind: str
) -> TelemetryEvent | None:
    for event in reversed(events):
        if event.event == kind:
            return event
    return None


def _recovery_distances(
    faults: list[TelemetryEvent], recoveries: list[TelemetryEvent]
) -> list[int]:
    # steps from each fault to the next productive recovery, if any
    productive_steps = sorted(
        e.step
        for e in recoveries
        if e.step is not None and e.recovery not in _NON_PRODUCTIVE
    )
    distances: list[int] = []
    for fault in faults:
        if fault.step is None:
            continue
        next_recovery = next(
            (s for s in productive_steps if s >= fault.step), None
        )
        if next_recovery is not None:
            distances.append(next_recovery - fault.step)
    return distances


def _total_tokens(events: list[TelemetryEvent]) -> int:
    return sum(
        e.tokens_used or 0 for e in events if e.event == "agent_done"
    )


def _deception(
    oracle_present: bool,
    dones: list[TelemetryEvent],
    lied_to: set[int],
    success_map: dict[int, bool | None],
) -> tuple[float | None, str | None]:
    # deception-detection rate, gated on a deception-aware oracle
    if not oracle_present:
        return None, "no_oracle"
    # Absent flag ⇒ True so pre-WP reference runs (no flag) still compute.
    deception_aware = any(d.payload.get("deception_aware", True) for d in dones)
    if not deception_aware:
        return None, "deception_requires_reference_oracle"
    if not lied_to:
        return None, "no_deception_probe"
    rate = sum(1 for a in lied_to if success_map.get(a) is True) / len(lied_to)
    return rate, None


def _latency_degradation(
    events: list[TelemetryEvent], control_events: list[TelemetryEvent]
) -> float | None:
    # compute latency degradation as ratio of mean durations
    chaos = _mean_duration(events)
    control = _mean_duration(control_events)
    if chaos is None or control is None or control == 0:
        return None
    return chaos / control


def _mean_duration(events: list[TelemetryEvent]) -> float | None:
    durations = [
        e.payload["duration_ms"]
        for e in events
        if e.event == "agent_done"
        and isinstance(e.payload.get("duration_ms"), (int, float))
    ]
    return sum(durations) / len(durations) if durations else None
