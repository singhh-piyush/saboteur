"""Unit tests for the pure outcome / recovery classifiers (LLM-free).

These import only :mod:`saboteur.agents.outcomes`, so they run with no model
and no smolagents agent loop (invariant #4). They drive the classifiers with
synthetic :class:`StepRecord` histories that mirror what the factory builds
from real ``ActionStep``s.
"""

from __future__ import annotations

from saboteur.agents.outcomes import (
    Outcome,
    RecoveryKind,
    StepRecord,
    classify_outcome,
    classify_recoveries,
)


def _step(
    step: int,
    tool: str | None,
    args=None,
    *,
    faults: tuple[str, ...] = (),
    errored: bool = False,
    observation: str | None = None,
) -> StepRecord:
    return StepRecord(
        step=step,
        tool_name=tool,
        arguments=args,
        faulted=bool(faults),
        fault_types=faults,
        errored=errored,
        observation=observation,
    )


# ---------------------------------------------------------------------------
# classify_recoveries
# ---------------------------------------------------------------------------

class TestClassifyRecoveries:
    def test_retry_same_tool_same_args(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("api_error",), errored=True),
            _step(2, "weather", {"city": "Tokyo"}),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.RETRY
        assert recs[0].after_fault == "api_error"
        assert recs[0].step == 2

    def test_backoff_after_rate_limit(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("rate_limit",), errored=True),
            _step(2, "weather", {"city": "Tokyo"}),
        ]
        recs = classify_recoveries(history)
        # A repeat after a 429 is a backoff, not a blind retry.
        assert recs[0].kind is RecoveryKind.BACKOFF

    def test_fallback_to_different_tool(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("tool_vanish",), errored=True),
            _step(2, "web_search", {"query": "Tokyo temperature"}),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.FALLBACK_TOOL

    def test_replan_same_tool_different_args(self) -> None:
        history = [
            _step(1, "calculator", {"expression": "22 * 9 / 5 + 32"}, faults=("malformed",)),
            _step(2, "calculator", {"expression": "22.0 * 9 / 5 + 32"}),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.REPLAN

    def test_replan_no_tool_call(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("api_error",)),
            _step(2, None),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.REPLAN

    def test_gave_up_when_last_step_faulted(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}),
            _step(2, "weather", {"city": "Tokyo"}, faults=("timeout",), errored=True),
        ]
        recs = classify_recoveries(history)
        assert recs[-1].kind is RecoveryKind.GAVE_UP
        assert recs[-1].after_fault == "timeout"

    def test_terminal_false_suppresses_giveup(self) -> None:
        # Mid-run view: a faulted last step must NOT be reported as gave_up
        # before the agent has had its next turn.
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("timeout",), errored=True),
        ]
        assert classify_recoveries(history, terminal=False) == []
        live = classify_recoveries(history)  # terminal default True
        assert live[-1].kind is RecoveryKind.GAVE_UP

    def test_no_faults_yields_no_recoveries(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}),
            _step(2, "calculator", {"expression": "22.0 * 9 / 5 + 32"}),
            _step(3, "file_report", {"title": "T", "body": "71.6F"}),
        ]
        assert classify_recoveries(history) == []


# ---------------------------------------------------------------------------
# classify_outcome
# ---------------------------------------------------------------------------

class TestClassifyOutcome:
    def test_timeout_wins(self) -> None:
        assert (
            classify_outcome(
                [], filed_report=True, hit_step_cap=True, raised=True, timed_out=True
            )
            is Outcome.TIMEOUT
        )

    def test_hard_exception(self) -> None:
        assert (
            classify_outcome(
                [], filed_report=False, hit_step_cap=False, raised=True, timed_out=False
            )
            is Outcome.HARD_EXCEPTION
        )

    def test_infinite_retry_on_repeated_calls_at_cap(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("api_error",)),
            _step(2, "weather", {"city": "Tokyo"}, faults=("api_error",)),
            _step(3, "weather", {"city": "Tokyo"}, faults=("api_error",)),
        ]
        assert (
            classify_outcome(
                history,
                filed_report=False,
                hit_step_cap=True,
                raised=False,
                timed_out=False,
            )
            is Outcome.INFINITE_RETRY
        )

    def test_step_cap_without_repeats_is_not_infinite_retry(self) -> None:
        # Hit the cap but doing varied work, no report → silent abandonment.
        history = [
            _step(1, "weather", {"city": "Tokyo"}),
            _step(2, "calculator", {"expression": "x"}),
            _step(3, "web_search", {"query": "q"}),
        ]
        assert (
            classify_outcome(
                history,
                filed_report=False,
                hit_step_cap=True,
                raised=False,
                timed_out=False,
            )
            is Outcome.SILENT_ABANDONMENT
        )

    def test_silent_abandonment_when_no_report(self) -> None:
        assert (
            classify_outcome(
                [_step(1, "weather", {"city": "Tokyo"})],
                filed_report=False,
                hit_step_cap=False,
                raised=False,
                timed_out=False,
            )
            is Outcome.SILENT_ABANDONMENT
        )

    def test_completed_when_report_filed(self) -> None:
        assert (
            classify_outcome(
                [_step(1, "file_report", {"title": "T", "body": "71.6"})],
                filed_report=True,
                hit_step_cap=False,
                raised=False,
                timed_out=False,
            )
            is Outcome.COMPLETED
        )
