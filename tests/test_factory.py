"""Unit tests for the pure outcome / recovery classifiers (LLM-free).

These import only :mod:`saboteur.agents.outcomes`, so they run with no model
and no smolagents agent loop (invariant #4). They drive the classifiers with
synthetic :class:`StepRecord` histories that mirror what the factory builds
from real ``ActionStep``s.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from saboteur.agents.outcomes import (
    AgentEvent,
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

    def test_retry_after_rate_limit_is_not_a_distinct_backoff(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("rate_limit",), errored=True),
            _step(2, "weather", {"city": "Tokyo"}),
        ]
        recs = classify_recoveries(history)
        # A same-tool/same-args re-call after a 429 is just a retry: telemetry
        # can't witness whether the agent actually waited, so we don't claim a
        # separate "backoff".
        assert recs[0].kind is RecoveryKind.RETRY

    def test_fallback_to_different_tool(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("tool_vanish",), errored=True),
            _step(2, "web_search", {"query": "Tokyo temperature"}),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.FALLBACK_TOOL

    def test_reformulate_same_tool_different_args(self) -> None:
        history = [
            _step(1, "calculator", {"expression": "22 * 9 / 5 + 32"}, faults=("malformed",)),
            _step(2, "calculator", {"expression": "22.0 * 9 / 5 + 32"}),
        ]
        recs = classify_recoveries(history)
        assert recs[0].kind is RecoveryKind.REFORMULATE

    def test_no_action_when_no_tool_call(self) -> None:
        history = [
            _step(1, "weather", {"city": "Tokyo"}, faults=("api_error",)),
            _step(2, None),
        ]
        recs = classify_recoveries(history)
        # No tool call after a fault is a stall, not a recovery.
        assert recs[0].kind is RecoveryKind.NO_ACTION

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
            _step(3, "file_report", {"fahrenheit": "71.6"}),
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
                [_step(1, "file_report", {"fahrenheit": "71.6"})],
                filed_report=True,
                hit_step_cap=False,
                raised=False,
                timed_out=False,
            )
            is Outcome.COMPLETED
        )


# ---------------------------------------------------------------------------
# Parse-error telemetry (factory._on_step)
# ---------------------------------------------------------------------------

# Minimal AgentParsingError stand-in (no smolagents import needed).
_AgentParsingError = type("AgentParsingError", (Exception,), {})


def _make_parse_error_step(prose: str) -> Any:
    """A fake ActionStep that mimics a parse failure."""
    return SimpleNamespace(
        step_number=3,
        tool_calls=[],
        model_output=prose,
        model_output_message=None,
        observations=None,
        error=_AgentParsingError("The model output does not contain any JSON blob"),
    )


class TestParseErrorTelemetry:
    """_on_step emits parse_error metadata in the step_start payload."""

    def _build_agent(self) -> tuple[Any, list[AgentEvent]]:
        """Build a SaboteurAgent with a capturing on_event; engine left None."""
        from saboteur.agents.factory import SaboteurAgent
        from saboteur.agents.tools import ReportStore

        events: list[AgentEvent] = []
        shell = SaboteurAgent(
            agent_id=99,
            store=ReportStore(),
            on_event=events.append,
        )
        # engine stays None — no chaos, no context_drop; step_hook is guarded.
        # Inject a minimal smolagents agent stand-in so _on_step can read
        # step_number (via getattr with a fallback) and engine.step_hook is
        # never reached.
        from unittest.mock import MagicMock
        shell.agent = MagicMock()
        shell.agent.step_number = 3
        return shell, events

    def test_parse_error_in_payload(self) -> None:
        """step_start payload carries parse_error=True and the raw model output."""
        shell, events = self._build_agent()
        prose = "The temperature in Tokyo is 22 °C, which is 71.6 °F."

        shell._on_step(_make_parse_error_step(prose))

        step_events = [e for e in events if e.kind == "step_start"]
        assert step_events, "no step_start event emitted"
        payload = step_events[0].data
        assert payload.get("parse_error") is True
        assert payload.get("model_output") == prose
        assert "AgentParsingError" in payload.get("error", "")

    def test_normal_step_has_empty_payload(self) -> None:
        """step_start for a successful tool call must NOT carry parse_error."""
        shell, events = self._build_agent()

        # _on_step only reads memory_step via getattr, so a SimpleNamespace is
        # sufficient — no need for the real ActionStep (which requires Timing).
        # _build_record accesses tool_call.name and tool_call.arguments directly,
        # so we use smolagents.memory.ToolCall (not ChatMessageToolCall).
        from smolagents.memory import ToolCall

        tc = ToolCall(name="weather", arguments={"city": "Tokyo"}, id="c1")
        memory_step = SimpleNamespace(
            step_number=1,
            tool_calls=[tc],
            model_output="",
            observations="22.0",
            error=None,
        )

        shell._on_step(memory_step)

        step_events = [e for e in events if e.kind == "step_start"]
        assert step_events, "no step_start event emitted"
        assert step_events[0].data == {}


# ---------------------------------------------------------------------------
# Wall-clock timeout verdict (regression: MI300X run — timeout + success:true)
# ---------------------------------------------------------------------------


class TestTimeoutVerdict:
    """A wall-clock-killed run must never freeze ``success=True``.

    ``asyncio.wait_for`` cannot kill the smolagents worker thread, so on
    timeout the orphan thread keeps running and can file a valid report into
    the store before ``verify()`` reads it — which used to score a killed
    agent as a pass (MI300X run, agent 6). The verdict derivation must freeze
    a failure without consulting the oracle; the outcome taxonomy and the
    (pure) scorer are untouched.
    """

    async def test_timeout_freezes_failure_despite_passing_verifier(
        self, monkeypatch
    ) -> None:
        import time

        from saboteur import config as cfg
        from saboteur.agents.factory import SaboteurAgent
        from saboteur.agents.tools import FiledReport

        # AGENT_TIMEOUT_S must flow from the environment to asyncio.wait_for
        # end-to-end (the heavy-model config knob) — the stub below is killed
        # at this ceiling, which proves the plumbing too.
        monkeypatch.setenv("AGENT_TIMEOUT_S", "1")
        cfg.get_settings.cache_clear()
        try:
            # The store already holds a PASSING report — mimicking the orphan
            # worker thread that completes the task around/after the kill.
            store = {7: [FiledReport(title="Tokyo report", body="71.6 F")]}
            events: list[AgentEvent] = []
            shell = SaboteurAgent(agent_id=7, store=store, on_event=events.append)
            shell.agent = SimpleNamespace(
                run=lambda *a, **k: time.sleep(2.0), step_number=1
            )

            result = await shell.run()
        finally:
            cfg.get_settings.cache_clear()

        assert result.outcome is Outcome.TIMEOUT
        # The raw verifier verdict stays honest (the report IS valid)…
        assert result.task_result.success is True
        # …but the frozen success verdict must be a failure: the run never
        # returned, so it cannot be a pass.
        terminal = next(e for e in events if e.kind == "terminal")
        assert terminal.data["outcome"] == "timeout"
        assert terminal.data["success"] is False
        assert "timeout" in terminal.data["oracle_detail"]
