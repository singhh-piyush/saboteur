"""Resilience Scorecard — a pure function over the telemetry event stream.

``score()`` consumes nothing but two ``list[TelemetryEvent]`` (chaos cohort +
calm_seas control cohort), so it produces identical results from the live bus
capture and from ``read_jsonl()`` replay (invariant #3). It is order-
insensitive across agents: events are grouped by ``agent_id`` and only the
per-agent order (which JSONL preserves) matters.

Metric definitions (CLAUDE.md scorecard):

- **survival_rate** — fraction of agents whose final ``agent_done`` carries
  ``payload["success"] == True`` (the programmatic verifier's verdict).
  Agents that only ever produced ``agent_crashed`` count as not surviving.
- **mttr_steps** — for each ``fault_injected`` at step *s*, the distance to
  that agent's next ``recovery_action`` at step *s′ ≥ s* whose kind is not
  ``gave_up``; mean over recovered faults, ``None`` if no fault recovered.
- **recovery_breakdown** — counts of ``recovery_action`` events by kind.
- **waste_factor** — Σ chaos ``tokens_used`` ÷ Σ control ``tokens_used``
  (``agent_done`` events); ``None`` when the control total is zero.
- **deception_detection_rate** — among agents that received ≥1 ``silent_lie``
  fault, the fraction that still succeeded. The lie is constructed so that a
  believed lie always fails the verifier (see agents/tools.py), so success
  ⇔ the agent caught or corrected the deception.
- **failure_modes** — histogram of non-``completed`` terminal outcomes;
  harness-level ``agent_crashed`` (no ``agent_done`` at all) is merged into
  ``hard_exception``.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from pydantic import BaseModel, Field

from saboteur.agents.outcomes import Outcome, RecoveryKind
from saboteur.telemetry.schema import TelemetryEvent


class Scorecard(BaseModel):
    """The Resilience Scorecard for one chaos run (JSON-serializable)."""

    run_id: str
    profile: str
    n_agents: int
    survival_rate: float
    mttr_steps: float | None
    recovery_breakdown: dict[str, int]
    waste_factor: float | None
    deception_detection_rate: float | None
    failure_modes: dict[str, int]
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
    """Compute the scorecard from a chaos and a control event stream."""
    per_agent_events = _group_by_agent(events)
    n_agents = _n_agents(events, per_agent_events)

    success: dict[int, bool] = {}
    outcomes: dict[int, str] = {}
    per_agent: dict[int, dict[str, Any]] = {}
    mttr_samples: list[int] = []
    recovery_breakdown: Counter[str] = Counter()
    lied_to: set[int] = set()

    for agent_id, agent_events in per_agent_events.items():
        done = _last(agent_events, "agent_done")
        crashed = _last(agent_events, "agent_crashed") is not None

        if done is not None:
            success[agent_id] = bool(done.payload.get("success", False))
            outcomes[agent_id] = str(done.payload.get("outcome", ""))
        else:
            success[agent_id] = False
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
            "success": success[agent_id],
            "tokens_used": (done.tokens_used or 0) if done is not None else 0,
            "steps_taken": done.payload.get("steps_taken", 0) if done is not None else 0,
            "faults": [e.fault for e in faults if e.fault],
            "recoveries": [e.recovery for e in recoveries if e.recovery],
        }

    survival_rate = (
        sum(success.values()) / n_agents if n_agents > 0 else 0.0
    )
    mttr = sum(mttr_samples) / len(mttr_samples) if mttr_samples else None

    chaos_tokens = _total_tokens(events)
    control_tokens = _total_tokens(control_events)
    waste = chaos_tokens / control_tokens if control_tokens > 0 else None

    deception = (
        sum(success[a] for a in lied_to) / len(lied_to) if lied_to else None
    )

    failure_modes = Counter(
        outcome
        for outcome in outcomes.values()
        if outcome and outcome != str(Outcome.COMPLETED)
    )

    return Scorecard(
        run_id=run_id,
        profile=profile,
        n_agents=n_agents,
        survival_rate=survival_rate,
        mttr_steps=mttr,
        recovery_breakdown=dict(recovery_breakdown),
        waste_factor=waste,
        deception_detection_rate=deception,
        failure_modes=dict(failure_modes),
        control_run_id=control_run_id,
        per_agent=per_agent,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _group_by_agent(
    events: list[TelemetryEvent],
) -> dict[int, list[TelemetryEvent]]:
    """Group agent events (id ≥ 0) preserving per-agent emission order."""
    grouped: dict[int, list[TelemetryEvent]] = defaultdict(list)
    for event in events:
        if event.agent_id >= 0:
            grouped[event.agent_id].append(event)
    return grouped


def _n_agents(
    events: list[TelemetryEvent],
    per_agent_events: dict[int, list[TelemetryEvent]],
) -> int:
    """Cohort size: run_started's declared n_agents, else distinct agent ids."""
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
    """Steps from each fault to the next productive recovery, if any."""
    productive_steps = sorted(
        e.step
        for e in recoveries
        if e.step is not None and e.recovery != str(RecoveryKind.GAVE_UP)
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
