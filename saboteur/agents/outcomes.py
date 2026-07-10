"""Pure outcome and recovery classification.

Converts StepRecord lists to a terminal Outcome and RecoveryEvents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from saboteur.chaos.events import FaultEvent

from .verifier import TaskResult




class Outcome(StrEnum):
    # terminal state of one agent run

    COMPLETED = "completed"
    INFINITE_RETRY = "infinite_retry"
    HARD_EXCEPTION = "hard_exception"
    TIMEOUT = "timeout"
    SILENT_ABANDONMENT = "silent_abandonment"


class RecoveryKind(StrEnum):
    # reaction to a fault, classified from telemetry

    RETRY = "retry"
    REFORMULATE = "reformulate"
    FALLBACK_TOOL = "fallback_tool"
    NO_ACTION = "no_action"
    GAVE_UP = "gave_up"




@dataclass(frozen=True)
class StepRecord:
    # a smolagents step projected to fault-relevant fields

    step: int
    tool_name: str | None
    arguments: Any
    faulted: bool
    fault_types: tuple[str, ...]
    errored: bool
    observation: str | None


@dataclass(frozen=True)
class RecoveryEvent:
    # a classified reaction to the fault on the preceding step

    step: int
    kind: RecoveryKind
    after_fault: str


@dataclass(frozen=True)
class AgentEvent:
    # an agent-local telemetry event

    agent_id: int
    step: int | None
    kind: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentRunResult:
    # result of SaboteurAgent.run, consumed by the harness

    agent_id: int
    outcome: Outcome
    task_result: TaskResult | None
    tokens_used: int
    steps_taken: int
    recoveries: list[RecoveryEvent] = field(default_factory=list)
    faults: list[FaultEvent] = field(default_factory=list)
    error: str | None = None




def classify_recoveries(
    history: list[StepRecord], *, terminal: bool = True
) -> list[RecoveryEvent]:
    # classify the agent transition that follows each faulted step
    events: list[RecoveryEvent] = []
    for i in range(1, len(history)):
        prev = history[i - 1]
        cur = history[i]
        if not prev.faulted:
            continue

        after = prev.fault_types[-1] if prev.fault_types else ""
        kind = _classify_transition(prev, cur)
        events.append(RecoveryEvent(step=cur.step, kind=kind, after_fault=after))

    # end-of-run fault with no follow-up counts as a give-up for survival scoring
    if terminal and history and history[-1].faulted:
        last = history[-1]
        after = last.fault_types[-1] if last.fault_types else ""
        events.append(
            RecoveryEvent(step=last.step, kind=RecoveryKind.GAVE_UP, after_fault=after)
        )
    return events


def _classify_transition(prev: StepRecord, cur: StepRecord) -> RecoveryKind:
    # no tool call after fault indicates a stall or parse failure
    if cur.tool_name is None:
        return RecoveryKind.NO_ACTION

    if cur.tool_name == prev.tool_name:
        # same tool with identical arguments is classified as a retry
        if cur.arguments == prev.arguments:
            return RecoveryKind.RETRY
        # same tool with different arguments is classified as reformulate
        return RecoveryKind.REFORMULATE

    # different tool is classified as fallback_tool
    return RecoveryKind.FALLBACK_TOOL




def classify_outcome(
    history: list[StepRecord],
    *,
    filed_report: bool,
    hit_step_cap: bool,
    raised: bool,
    timed_out: bool,
    repeat_threshold: int = 3,
) -> Outcome:
    # classify terminal state based on timeouts, exceptions, infinite retries, or filed reports
    if timed_out:
        return Outcome.TIMEOUT
    if raised:
        return Outcome.HARD_EXCEPTION
    if hit_step_cap and _max_identical_streak(history) >= repeat_threshold:
        return Outcome.INFINITE_RETRY
    if not filed_report:
        return Outcome.SILENT_ABANDONMENT
    return Outcome.COMPLETED


def _max_identical_streak(history: list[StepRecord]) -> int:
    # longest run of consecutive identical (tool_name, arguments) calls
    best = 0
    streak = 0
    prev_key: tuple[str | None, Any] | None = None
    for rec in history:
        if rec.tool_name is None:
            streak = 0
            prev_key = None
            continue
        key = (rec.tool_name, _hashable(rec.arguments))
        if key == prev_key:
            streak += 1
        else:
            streak = 1
            prev_key = key
        best = max(best, streak)
    return best


def _hashable(arguments: Any) -> Any:
    # best-effort stable key for argument equality comparison
    if isinstance(arguments, dict):
        return tuple(sorted((k, _hashable(v)) for k, v in arguments.items()))
    if isinstance(arguments, (list, tuple)):
        return tuple(_hashable(v) for v in arguments)
    return arguments
