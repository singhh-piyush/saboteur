"""Oracle + two-tier scorecard tests (LLM-free).

Covers:
  1. Each oracle's ``judge`` (BuiltinReference / Regex / AssertionCommand /
     HttpCallback) over hand-built contexts — no LLM, no network (HTTP is
     monkeypatched).
  2. ``score()`` gating: oracle-gated metrics are null + an explicit reason when
     no/ineligible oracle; behavioral metrics are identical regardless.
  3. The frozen-verdict regression anchor: re-scoring on-disk liars_den /
     hell_mode JSONL reproduces the captured survival / deception numbers.
  4. Old-scorecard backward-compat (new fields are defaulted).
  5. The factory freezes the verdict + provenance into ``agent_done`` at
     completion, and a BYO oracle overrides the reference verdict.
"""

from __future__ import annotations

import json
import types
import urllib.request
from pathlib import Path

import pytest

from saboteur.agents.factory import SaboteurAgent
from saboteur.agents.oracle import (
    AssertionCommandOracle,
    BuiltinReferenceOracle,
    HttpCallbackOracle,
    OracleRunContext,
    RegexOracle,
)
from saboteur.agents.tools import FiledReport
from saboteur.harness import Scorecard, score
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent

RUNS_DIR = Path(__file__).resolve().parent.parent / "runs"


def _ctx(**kw) -> OracleRunContext:
    kw.setdefault("agent_id", 0)
    return OracleRunContext(**kw)


# ---------------------------------------------------------------------------
# 1. Oracle units
# ---------------------------------------------------------------------------

def test_builtin_reference_oracle_passthrough() -> None:
    oracle = BuiltinReferenceOracle()
    assert oracle.deception_aware is True
    assert oracle.name == "builtin_reference"
    assert oracle.judge(_ctx(reference_success=True)).success is True
    assert oracle.judge(_ctx(reference_success=False)).success is False
    # Missing reference (BYO JSONL) never trips: defaults to a failure.
    assert oracle.judge(_ctx(reference_success=None)).success is False


def test_regex_oracle_hit_and_miss() -> None:
    oracle = RegexOracle(r"\b71\.6")
    assert oracle.deception_aware is False
    assert oracle.judge(_ctx(final_output="It is 71.6F today")).success is True
    assert oracle.judge(_ctx(final_output="It is 80F today")).success is False
    assert oracle.judge(_ctx(final_output=None)).success is False


def test_assertion_command_oracle_exit_code_stdin_and_env() -> None:
    # exit 0 iff the agent's final output (piped on stdin) contains 'hello'.
    grep = AssertionCommandOracle("grep -q hello")
    assert grep.judge(_ctx(final_output="hello world")).success is True
    assert grep.judge(_ctx(final_output="goodbye")).success is False
    # The environment carries the agent id.
    env_check = AssertionCommandOracle('test "$SABOTEUR_AGENT_ID" = "7"')
    assert env_check.judge(_ctx(agent_id=7, final_output="x")).success is True
    assert env_check.judge(_ctx(agent_id=3, final_output="x")).success is False


def test_assertion_command_oracle_timeout_is_a_failure_not_a_raise() -> None:
    slow = AssertionCommandOracle("sleep 5", timeout_s=0.2)
    verdict = slow.judge(_ctx(final_output="x"))
    assert verdict.success is False
    assert "timed out" in verdict.detail


class _FakeResp:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def test_http_callback_oracle(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_urlopen(request, timeout=None):  # noqa: ANN001
        return _FakeResp(json.dumps({"success": True}).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    oracle = HttpCallbackOracle("http://example.test/judge")
    assert oracle.deception_aware is False
    assert oracle.judge(_ctx(final_output="x")).success is True


def test_http_callback_oracle_network_error_is_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(request, timeout=None):  # noqa: ANN001
        raise OSError("no network")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    verdict = HttpCallbackOracle("http://example.test/judge").judge(_ctx())
    assert verdict.success is False
    assert "error" in verdict.detail


# ---------------------------------------------------------------------------
# 2. score() gating
# ---------------------------------------------------------------------------

def _tev(
    agent_id: int,
    event: str,
    *,
    step: int | None = None,
    fault: str | None = None,
    recovery: str | None = None,
    tokens_used: int | None = None,
    payload: dict | None = None,
    run_id: str = "r",
) -> TelemetryEvent:
    return TelemetryEvent(
        run_id=run_id,
        agent_id=agent_id,
        step=step,
        event=event,
        fault=fault,
        recovery=recovery,
        tokens_used=tokens_used,
        payload=payload or {},
    )


def _done(
    agent_id: int,
    *,
    success: bool | None,
    oracle: str | None = None,
    deception_aware: bool | None = None,
    outcome: str = "completed",
    tokens: int = 100,
    duration_ms: float | None = None,
) -> TelemetryEvent:
    payload: dict = {"outcome": outcome, "success": success, "steps_taken": 3}
    if oracle is not None:
        payload["oracle"] = oracle
    if deception_aware is not None:
        payload["deception_aware"] = deception_aware
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    return _tev(agent_id, "agent_done", tokens_used=tokens, payload=payload)


def test_no_oracle_gates_both_metrics() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 2}),
        _done(0, success=None),
        _done(1, success=None),
        _tev(-1, "run_finished", payload={"n_agents": 2}),
    ]
    card = score(events, [], run_id="r", profile="p")
    assert card.survival_rate is None
    assert card.survival_rate_reason == "no_oracle"
    assert card.deception_detection_rate is None
    assert card.deception_detection_rate_reason == "no_oracle"
    assert card.oracle is None


def test_byo_oracle_computes_survival_but_gates_deception() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 2}),
        _tev(0, "fault_injected", step=1, fault="silent_lie"),
        _done(0, success=True, oracle="regex", deception_aware=False),
        _tev(1, "fault_injected", step=1, fault="silent_lie"),
        _done(1, success=False, oracle="regex", deception_aware=False),
        _tev(-1, "run_finished", payload={"n_agents": 2}),
    ]
    card = score(events, [], run_id="r", profile="p")
    assert card.survival_rate == pytest.approx(0.5)
    assert card.survival_rate_reason is None
    assert card.oracle == "regex"
    assert card.deception_detection_rate is None
    assert card.deception_detection_rate_reason == "deception_requires_reference_oracle"


def test_deception_aware_oracle_without_probe() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 1}),
        _done(0, success=True, oracle="builtin_reference", deception_aware=True),
        _tev(-1, "run_finished", payload={"n_agents": 1}),
    ]
    card = score(events, [], run_id="r", profile="p")
    assert card.survival_rate == 1.0
    assert card.deception_detection_rate is None
    assert card.deception_detection_rate_reason == "no_deception_probe"


def test_behavioral_metrics_identical_regardless_of_oracle() -> None:
    def stream(with_oracle: bool) -> list[TelemetryEvent]:
        return [
            _tev(-1, "run_started", payload={"n_agents": 2}),
            _tev(0, "fault_injected", step=1, fault="api_error"),
            _tev(0, "recovery_action", step=2, recovery="retry"),
            _done(
                0,
                success=True if with_oracle else None,
                oracle="builtin_reference" if with_oracle else None,
                deception_aware=True if with_oracle else None,
                tokens=1000,
                duration_ms=100.0,
            ),
            _tev(1, "agent_crashed", payload={"error": "boom"}),
            _tev(-1, "run_finished", payload={"n_agents": 2}),
        ]

    control = [
        _tev(-1, "run_started", payload={"n_agents": 1}, run_id="c"),
        _done(0, success=True, tokens=500, duration_ms=50.0),
        _tev(-1, "run_finished", payload={"n_agents": 1}, run_id="c"),
    ]
    with_o = score(stream(True), control, run_id="r", profile="p")
    without_o = score(stream(False), control, run_id="r", profile="p")

    for field in (
        "mttr_steps",
        "recovery_breakdown",
        "waste_factor",
        "failure_modes",
        "crash_rate",
        "latency_degradation",
    ):
        assert getattr(with_o, field) == getattr(without_o, field), field

    # Sanity on the values themselves.
    assert with_o.mttr_steps == pytest.approx(1.0)
    assert with_o.crash_rate == pytest.approx(0.5)  # agent 1 hard-crashed
    assert with_o.waste_factor == pytest.approx(1000 / 500)
    assert with_o.latency_degradation == pytest.approx(100 / 50)

    # But the gated tier diverges.
    assert with_o.survival_rate is not None
    assert without_o.survival_rate is None


def test_crash_rate_is_not_one_minus_survival() -> None:
    # A timeout is not a hard crash: crash_rate counts only hard_exception.
    events = [
        _tev(-1, "run_started", payload={"n_agents": 2}),
        _done(0, success=False, oracle="builtin_reference", deception_aware=True,
              outcome="timeout"),
        _done(1, success=False, oracle="builtin_reference", deception_aware=True,
              outcome="timeout"),
        _tev(-1, "run_finished", payload={"n_agents": 2}),
    ]
    card = score(events, [], run_id="r", profile="p")
    assert card.survival_rate == 0.0
    assert card.crash_rate == 0.0  # timeouts, not hard_exception
    assert card.failure_modes == {"timeout": 2}


def test_latency_degradation_none_without_durations() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 1}),
        _done(0, success=True, oracle="builtin_reference", deception_aware=True),
        _tev(-1, "run_finished", payload={"n_agents": 1}),
    ]
    card = score(events, events, run_id="r", profile="p")
    assert card.latency_degradation is None


# ---------------------------------------------------------------------------
# 3. Regression anchor: frozen verdicts reproduce the on-disk numbers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("profile", ["liars_den", "hell_mode"])
def test_regression_anchor_reproduces_frozen_metrics(profile: str) -> None:
    jsonls = sorted(
        p
        for p in RUNS_DIR.glob(f"{profile}-*.jsonl")
        if "-control" not in p.name
    )
    checked = 0
    for jsonl in jsonls:
        scorecard_path = jsonl.parent / (jsonl.stem + ".scorecard.json")
        if not scorecard_path.exists():
            continue
        expected = json.loads(scorecard_path.read_text(encoding="utf-8"))
        card = score(
            read_jsonl(jsonl),
            [],
            run_id=expected["run_id"],
            profile=profile,
        )
        assert card.survival_rate == pytest.approx(expected["survival_rate"])
        if expected["deception_detection_rate"] is None:
            assert card.deception_detection_rate is None
        else:
            assert card.deception_detection_rate == pytest.approx(
                expected["deception_detection_rate"]
            )
        checked += 1
    if checked == 0:
        pytest.skip(f"no {profile} run artifacts with scorecards on disk")


def test_old_scorecard_still_validates() -> None:
    cards = sorted(RUNS_DIR.glob("*.scorecard.json"))
    if not cards:
        pytest.skip("no scorecards on disk")
    card = Scorecard.model_validate_json(cards[0].read_text(encoding="utf-8"))
    assert card.run_id
    # New fields are present via defaults even for a pre-WP file.
    assert isinstance(card.crash_rate, float)


def test_legacy_minimal_scorecard_loads_with_defaults() -> None:
    """A pre-two-tier scorecard (none of crash_rate / oracle / *_reason / latency)
    must still validate, with the new fields filled from their defaults."""
    legacy = json.dumps(
        {
            "run_id": "flaky_friday-20260101T000000-legacy",
            "profile": "flaky_friday",
            "n_agents": 8,
            "survival_rate": 0.75,  # pre-WP: survival was a plain required float
            "mttr_steps": 2.5,
            "recovery_breakdown": {"retry": 4},
            "waste_factor": 1.4,
            "deception_detection_rate": 0.5,
            "failure_modes": {"timeout": 1},
            "control_run_id": "flaky_friday-20260101T000000-legacy-control",
            "per_agent": {},
        }
    )
    card = Scorecard.model_validate_json(legacy)
    assert card.survival_rate == 0.75
    # Fields added by later WPs are defaulted, not required.
    assert card.crash_rate == 0.0
    assert card.latency_degradation is None
    assert card.oracle is None
    assert card.survival_rate_reason is None
    assert card.deception_detection_rate_reason is None


# ---------------------------------------------------------------------------
# 5. Completion-time freezing (no LLM; stub the agent loop)
# ---------------------------------------------------------------------------

class _StubRun:
    def __init__(self, output: str) -> None:
        self.output = output
        self.state = "success"
        self.token_usage = types.SimpleNamespace(input_tokens=5, output_tokens=5)


class _StubAgent:
    step_number = 0

    def __init__(self, output: str) -> None:
        self._output = output

    def run(self, prompt: str, return_full_result: bool = True) -> _StubRun:
        return _StubRun(self._output)


async def test_factory_freezes_verdict_and_provenance() -> None:
    captured: list = []
    store = {0: [FiledReport(title="Tokyo", body="71.6")]}
    shell = SaboteurAgent(
        0, store, on_event=captured.append, oracle=RegexOracle(r"71\.6")
    )
    shell.agent = _StubAgent("The Tokyo temperature is 71.6 degrees F")

    await shell.run()

    terminal = [e for e in captured if e.kind == "terminal"][-1]
    assert terminal.data["oracle"] == "regex"
    assert terminal.data["deception_aware"] is False
    assert terminal.data["success"] is True
    assert terminal.data["final_output"] == "The Tokyo temperature is 71.6 degrees F"
    assert isinstance(terminal.data["duration_ms"], float)


async def test_byo_oracle_overrides_reference_verdict() -> None:
    captured: list = []
    # The store would pass the reference verifier (71.6), but the regex oracle
    # looks for something absent → the frozen verdict follows the oracle.
    store = {0: [FiledReport(title="Tokyo", body="71.6")]}
    shell = SaboteurAgent(
        0, store, on_event=captured.append, oracle=RegexOracle(r"NOPE")
    )
    shell.agent = _StubAgent("71.6 here")

    await shell.run()

    terminal = [e for e in captured if e.kind == "terminal"][-1]
    assert terminal.data["success"] is False
    assert terminal.data["oracle"] == "regex"


async def test_default_oracle_is_builtin_reference() -> None:
    captured: list = []
    store = {0: [FiledReport(title="Tokyo", body="71.6")]}
    shell = SaboteurAgent(0, store, on_event=captured.append)  # no oracle → builtin
    shell.agent = _StubAgent("filed 71.6")

    await shell.run()

    terminal = [e for e in captured if e.kind == "terminal"][-1]
    assert terminal.data["oracle"] == "builtin_reference"
    assert terminal.data["deception_aware"] is True
    assert terminal.data["success"] is True  # reference verifier passed
