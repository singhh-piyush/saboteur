"""Pure, LLM-free outcome and recovery classification.

This module is the unit-testable core of the agent layer: it imports no
smolagents and runs no model. The factory (``factory.py``) projects each
smolagents ``ActionStep`` into a neutral :class:`StepRecord`, and the pure
functions here turn a list of those records into:

- a terminal :class:`Outcome` (CLAUDE.md failure-mode taxonomy), and
- a list of :class:`RecoveryEvent` (CLAUDE.md scorecard categories).

Keeping this logic pure means scoring stays a function over the event
stream (invariant #3) and the classifiers can be tested without a live LLM
(invariant #4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from saboteur.chaos.events import FaultEvent

from .verifier import TaskResult


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Outcome(StrEnum):
    """Terminal state of one agent run (CLAUDE.md failure-mode taxonomy)."""

    COMPLETED = "completed"
    INFINITE_RETRY = "infinite_retry"
    HARD_EXCEPTION = "hard_exception"
    TIMEOUT = "timeout"
    SILENT_ABANDONMENT = "silent_abandonment"


class RecoveryKind(StrEnum):
    """How an agent reacted to a fault (CLAUDE.md scorecard categories)."""

    RETRY = "retry"
    BACKOFF = "backoff"
    FALLBACK_TOOL = "fallback_tool"
    REPLAN = "replan"
    GAVE_UP = "gave_up"


# ---------------------------------------------------------------------------
# Neutral projections (built in factory.py, consumed here)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StepRecord:
    """A smolagents ``ActionStep`` projected to fault-relevant fields.

    ``arguments`` is whatever smolagents recorded on the ``ToolCall`` (a dict
    or a raw string); it is compared by equality to detect a retry, so it is
    kept as-is. ``fault_types`` are the ``FaultType`` string values stamped to
    this step by the engine's ``on_fault`` callback.
    """

    step: int
    tool_name: str | None
    arguments: Any
    faulted: bool
    fault_types: tuple[str, ...]
    errored: bool
    observation: str | None


@dataclass(frozen=True)
class RecoveryEvent:
    """A classified reaction to the fault on the preceding step."""

    step: int
    kind: RecoveryKind
    after_fault: str


@dataclass(frozen=True)
class AgentEvent:
    """An agent-local telemetry event emitted through ``on_event``.

    The harness / telemetry bus later enriches this with ``run_id`` and ``ts``
    to form the canonical telemetry event (invariant #3). ``kind`` is one of
    ``"step_start"``, ``"tool_call"``, ``"fault"``, ``"recovery"``,
    ``"terminal"``.
    """

    agent_id: int
    step: int | None
    kind: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentRunResult:
    """The full result of one ``SaboteurAgent.run()``.

    Distinct from smolagents' ``RunResult``: this is Saboteur's own scoring
    surface, consumed by the harness.
    """

    agent_id: int
    outcome: Outcome
    task_result: TaskResult | None
    tokens_used: int
    steps_taken: int
    recoveries: list[RecoveryEvent] = field(default_factory=list)
    faults: list[FaultEvent] = field(default_factory=list)
    error: str | None = None


# ---------------------------------------------------------------------------
# Recovery classifier (pure)
# ---------------------------------------------------------------------------

# Faults whose correct response is to wait out a Retry-After before retrying.
_BACKOFF_FAULT = "rate_limit"


def classify_recoveries(
    history: list[StepRecord], *, terminal: bool = True
) -> list[RecoveryEvent]:
    """Classify each agent reaction that follows a faulted step.

    Pure function over the step history (no LLM, no I/O). For every step whose
    *previous* step carried a fault, we classify the transition into one of the
    CLAUDE.md scorecard categories:

    - ``BACKOFF`` — prior fault was a rate-limit and the agent re-called the
      same tool (it honored the Retry-After rather than blindly hammering).
    - ``RETRY`` — same tool, same arguments again.
    - ``FALLBACK_TOOL`` — a *different* tool toward the same subgoal.
    - ``REPLAN`` — no tool call this step, or a tool whose arguments signal a
      changed approach (e.g. moving on to ``file_report``).
    - ``GAVE_UP`` — only when ``terminal`` and the run ended on a faulted step
      with no follow-up: the fault was the agent's last productive moment.

    ``terminal`` defaults to True (the end-of-run view used for scoring). The
    factory passes ``terminal=False`` for the live per-step view, so a faulted
    step is not prematurely reported as a give-up before the agent has had its
    next turn to recover.
    """
    events: list[RecoveryEvent] = []
    for i in range(1, len(history)):
        prev = history[i - 1]
        cur = history[i]
        if not prev.faulted:
            continue

        after = prev.fault_types[-1] if prev.fault_types else ""
        kind = _classify_transition(prev, cur, after)
        events.append(RecoveryEvent(step=cur.step, kind=kind, after_fault=after))

    # If the run ended on a faulted step with no follow-up at all, that fault
    # was a give-up point — surface it so survival/MTTR scoring sees it. Only
    # meaningful once the run is over (terminal view).
    if terminal and history and history[-1].faulted:
        last = history[-1]
        after = last.fault_types[-1] if last.fault_types else ""
        events.append(
            RecoveryEvent(step=last.step, kind=RecoveryKind.GAVE_UP, after_fault=after)
        )
    return events


def _classify_transition(prev: StepRecord, cur: StepRecord, after_fault: str) -> RecoveryKind:
    # No tool call at all on the recovery step → the agent changed approach
    # (or stalled). Treat as a replan rather than a retry.
    if cur.tool_name is None:
        return RecoveryKind.REPLAN

    same_tool = cur.tool_name == prev.tool_name
    if same_tool:
        if after_fault == _BACKOFF_FAULT:
            return RecoveryKind.BACKOFF
        if cur.arguments == prev.arguments:
            return RecoveryKind.RETRY
        # Same tool, different arguments → a reformulated attempt, not a
        # blind retry: closest scorecard bucket is a replan.
        return RecoveryKind.REPLAN

    # A different tool toward the same goal is the canonical fallback.
    return RecoveryKind.FALLBACK_TOOL


# ---------------------------------------------------------------------------
# Outcome classifier (pure)
# ---------------------------------------------------------------------------

def classify_outcome(
    history: list[StepRecord],
    *,
    filed_report: bool,
    hit_step_cap: bool,
    raised: bool,
    timed_out: bool,
    repeat_threshold: int = 3,
) -> Outcome:
    """Classify a run's terminal state (CLAUDE.md failure-mode taxonomy).

    Precedence (most severe / most specific first):

    1. ``timed_out``  → :attr:`Outcome.TIMEOUT` (wall-clock cap tripped).
    2. ``raised``     → :attr:`Outcome.HARD_EXCEPTION` (a non-AgentError
       escaped ``agent.run`` — injected faults never do this).
    3. ``hit_step_cap`` with ``>= repeat_threshold`` identical consecutive
       tool calls → :attr:`Outcome.INFINITE_RETRY`.
    4. no report filed → :attr:`Outcome.SILENT_ABANDONMENT`.
    5. otherwise       → :attr:`Outcome.COMPLETED`.
    """
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
    """Longest run of consecutive identical (tool_name, arguments) calls."""
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
    """Best-effort stable key for argument equality comparison."""
    if isinstance(arguments, dict):
        return tuple(sorted((k, _hashable(v)) for k, v in arguments.items()))
    if isinstance(arguments, (list, tuple)):
        return tuple(_hashable(v) for v in arguments)
    return arguments
