"""Tests for mock tools, task constants, and the programmatic verifier.

All tests run without a live LLM (CLAUDE.md invariant #4).
The integration test at the bottom proves silent_lie corruption is
detectable end-to-end through the real ChaosEngine.
"""

from __future__ import annotations

import pytest

from saboteur.agents import (
    GROUND_TRUTH,
    CalculatorTool,
    FailureReason,
    FiledReport,
    FileReportTool,
    ReportStore,
    WeatherTool,
    WebSearchTool,
    build_tools,
    verify,
)
from saboteur.chaos import (
    ChaosEngine,
    ChaosProfile,
    FaultSpec,
    FaultType,
)


# ---------------------------------------------------------------------------
# WeatherTool
# ---------------------------------------------------------------------------

class TestWeatherTool:
    def setup_method(self) -> None:
        self.tool = WeatherTool()

    def test_tokyo_returns_ground_truth(self) -> None:
        result = self.tool.forward("Tokyo")
        assert str(GROUND_TRUTH["tokyo_c"]) in result

    def test_tokyo_case_insensitive(self) -> None:
        assert str(GROUND_TRUTH["tokyo_c"]) in self.tool.forward("TOKYO")
        assert str(GROUND_TRUTH["tokyo_c"]) in self.tool.forward("tokyo")

    def test_known_city_london(self) -> None:
        result = self.tool.forward("London")
        assert "12.0" in result

    def test_unknown_city_returns_error_string(self) -> None:
        result = self.tool.forward("Atlantis")
        assert result.startswith("Error:")
        assert "Atlantis" in result
        # Lists known cities so the agent knows its options.
        assert "Tokyo" in result

    def test_returns_string(self) -> None:
        assert isinstance(self.tool.forward("Tokyo"), str)


# ---------------------------------------------------------------------------
# CalculatorTool
# ---------------------------------------------------------------------------

class TestCalculatorTool:
    def setup_method(self) -> None:
        self.tool = CalculatorTool()

    def test_celsius_to_fahrenheit(self) -> None:
        result = self.tool.forward("22.0 * 9 / 5 + 32")
        assert result == "71.6"

    def test_simple_addition(self) -> None:
        assert self.tool.forward("1 + 1") == "2"

    def test_float_result(self) -> None:
        assert self.tool.forward("1 / 3") == "0.3333"

    def test_integer_result_no_decimal(self) -> None:
        # 10 / 2 = 5.0 → should display as "5"
        assert self.tool.forward("10 / 2") == "5"

    def test_rejects_import_expression(self) -> None:
        result = self.tool.forward("__import__('os').system('echo hi')")
        assert result.startswith("Error:")
        # Must not raise; must not execute.

    def test_rejects_variable_name(self) -> None:
        result = self.tool.forward("x + 1")
        assert result.startswith("Error:")

    def test_rejects_function_call(self) -> None:
        result = self.tool.forward("abs(-5)")
        assert result.startswith("Error:")

    def test_division_by_zero(self) -> None:
        result = self.tool.forward("1 / 0")
        assert result.startswith("Error:")

    def test_returns_string(self) -> None:
        assert isinstance(self.tool.forward("2 + 2"), str)


# ---------------------------------------------------------------------------
# WebSearchTool
# ---------------------------------------------------------------------------

class TestWebSearchTool:
    def setup_method(self) -> None:
        self.tool = WebSearchTool()

    def test_tokyo_query_contains_22(self) -> None:
        result = self.tool.forward("tokyo temperature")
        assert "22.0" in result

    def test_celsius_formula_query(self) -> None:
        result = self.tool.forward("celsius to fahrenheit formula")
        assert "9/5" in result or "9 / 5" in result

    def test_unknown_query_returns_no_results(self) -> None:
        result = self.tool.forward("extremely obscure query xyz")
        assert "No results" in result

    def test_returns_string(self) -> None:
        assert isinstance(self.tool.forward("anything"), str)


# ---------------------------------------------------------------------------
# FileReportTool — crash isolation
# ---------------------------------------------------------------------------

class TestFileReportTool:
    def test_report_stored_under_correct_agent(self) -> None:
        store: ReportStore = {}
        tool = FileReportTool(agent_id=1, store=store)
        tool.forward("71.6")
        assert 1 in store
        assert len(store[1]) == 1
        assert store[1][0].body == "71.6"

    def test_two_agents_do_not_share_reports(self) -> None:
        store: ReportStore = {}
        t1 = FileReportTool(agent_id=1, store=store)
        t2 = FileReportTool(agent_id=2, store=store)
        t1.forward("71.6")
        t2.forward("80.0")
        assert 1 in store and 2 in store
        assert all(r.body == "71.6" for r in store[1])
        assert all(r.body == "80.0" for r in store[2])

    def test_returns_confirmation_string(self) -> None:
        store: ReportStore = {}
        tool = FileReportTool(agent_id=0, store=store)
        result = tool.forward("71.6")
        assert isinstance(result, str)
        assert "filed" in result.lower()


# ---------------------------------------------------------------------------
# build_tools — isolation helper
# ---------------------------------------------------------------------------

class TestBuildTools:
    def test_returns_four_tools(self) -> None:
        store: ReportStore = {}
        tools = build_tools(0, store)
        assert len(tools) == 4

    def test_tool_names(self) -> None:
        store: ReportStore = {}
        names = {t.name for t in build_tools(0, store)}
        assert names == {"weather", "calculator", "web_search", "file_report"}

    def test_fresh_instances_per_agent(self) -> None:
        store: ReportStore = {}
        t_a = build_tools(0, store)
        t_b = build_tools(1, store)
        # Different object identities.
        for ta, tb in zip(t_a, t_b):
            assert ta is not tb


# ---------------------------------------------------------------------------
# Verifier unit tests
# ---------------------------------------------------------------------------

class TestVerifier:
    def _store_with(self, agent_id: int, body: str) -> ReportStore:
        store: ReportStore = {}
        store[agent_id] = [FiledReport(title="Test", body=body)]
        return store

    def test_correct_value_succeeds(self) -> None:
        store = self._store_with(0, "The temperature in Tokyo is 71.6°F.")
        result = verify(store, 0)
        assert result.success is True
        assert result.failure_reason is None
        assert result.found_value == pytest.approx(71.6)

    def test_value_within_tolerance_succeeds(self) -> None:
        store = self._store_with(0, "Temperature: 71.9°F")
        result = verify(store, 0)
        assert result.success is True

    def test_silent_lie_value_detected(self) -> None:
        # Simulates a silent_lie-corrupted report (53.6°F = 71.6 - 18).
        store = self._store_with(0, "The temperature in Tokyo is 53.6°F.")
        result = verify(store, 0)
        assert result.success is False
        assert result.failure_reason is FailureReason.WRONG_VALUE
        assert result.found_value == pytest.approx(53.6)

    def test_no_report_gives_no_report(self) -> None:
        result = verify({}, 99)
        assert result.success is False
        assert result.failure_reason is FailureReason.NO_REPORT
        assert result.found_value is None

    def test_report_with_no_numbers_gives_malformed(self) -> None:
        store = self._store_with(0, "Tokyo is warm today.")
        result = verify(store, 0)
        assert result.success is False
        assert result.failure_reason is FailureReason.MALFORMED_REPORT
        assert result.found_value is None

    def test_custom_expected_and_tolerance(self) -> None:
        store = self._store_with(0, "Value: 100.0")
        # Exact match with custom expected.
        assert verify(store, 0, expected=100.0, tol=0.1).success is True
        # Outside tolerance.
        assert verify(store, 0, expected=98.0, tol=0.5).success is False

    def test_multiple_reports_closest_wins(self) -> None:
        # Agent filed two reports; second is correct.
        store: ReportStore = {
            7: [
                FiledReport("Bad", "Temperature: 53.0°F"),
                FiledReport("Good", "Temperature: 71.6°F"),
            ]
        }
        result = verify(store, 7)
        assert result.success is True
        assert result.found_value == pytest.approx(71.6)


# ---------------------------------------------------------------------------
# Integration: silent_lie end-to-end (invariant #4)
# ---------------------------------------------------------------------------

class TestSilentLieIntegration:
    """Prove that a silent_lie through the real ChaosEngine is detectable."""

    def test_silent_lie_on_calculator_gives_wrong_value(self) -> None:
        # Build a profile that always lies on every calculator call.
        # Default lie_offset=(10, 30) so the shift is at least 10 away from
        # the true result, well outside the verifier's tol=0.5.
        profile = ChaosProfile(
            name="always_lie",
            seed=7,
            faults=[
                FaultSpec(
                    type=FaultType.SILENT_LIE,
                    probability=1.0,
                    target_tools=["calculator"],
                )
            ],
        )

        store: ReportStore = {}
        tools = build_tools(agent_id=0, store=store)
        tool_map = {t.name: t for t in tools}

        engine = ChaosEngine(profile, agent_id=0)
        engine.sabotage_tool(tool_map["calculator"])

        # Call the sabotaged calculator with the correct C→F expression.
        lied_result = tool_map["calculator"].forward("22.0 * 9 / 5 + 32")

        # File the corrupted result — the agent "believes" this is correct.
        tool_map["file_report"].forward(str(lied_result))

        # Verify: the lie shifts the number by ≥10, so it's always WRONG_VALUE.
        result = verify(store, agent_id=0)
        assert result.success is False
        assert result.failure_reason is FailureReason.WRONG_VALUE
        # The lied value must differ from the truth by more than the tolerance.
        assert result.found_value is not None
        assert abs(result.found_value - GROUND_TRUTH["tokyo_f"]) > 0.5

    def test_no_lie_gives_success(self) -> None:
        """Control: the same flow without the chaos engine succeeds."""
        store: ReportStore = {}
        tools = build_tools(agent_id=1, store=store)
        tool_map = {t.name: t for t in tools}

        calc_result = tool_map["calculator"].forward("22.0 * 9 / 5 + 32")
        assert calc_result == "71.6"

        tool_map["file_report"].forward(calc_result)
        result = verify(store, agent_id=1)
        assert result.success is True

    def test_silent_lie_on_weather_preserves_celsius_corrupts_fahrenheit(self) -> None:
        """The two-unit weather reading is the deception surface (H1): the lie
        must leave the Celsius value true and corrupt only the derived
        Fahrenheit, so the pair is internally inconsistent and an agent that
        recomputes from Celsius can resist it."""
        import re

        profile = ChaosProfile(
            name="weather_liar",
            seed=3,
            faults=[
                FaultSpec(
                    type=FaultType.SILENT_LIE,
                    probability=1.0,
                    target_tools=["weather"],
                )
            ],
        )
        store: ReportStore = {}
        tool_map = {t.name: t for t in build_tools(agent_id=0, store=store)}
        ChaosEngine(profile, agent_id=0).sabotage_tool(tool_map["weather"])

        out = tool_map["weather"].forward("Tokyo")
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", out)]
        assert nums[0] == 22.0  # Celsius untouched (the trustworthy source)
        assert abs(nums[1] - 71.6) >= 10  # Fahrenheit shifted by the offset lie
