"""Harness tests — LLM-free, driven by FakeAgents through the factory seam.

Covers the WP5 acceptance criteria:
  1. Crash isolation — one agent raising never affects the others.
  2. Exact scoring math on a hand-built telemetry event log.
  3. calm_seas control ⇒ waste factor exactly 1.0.
  4. The concurrency limit (semaphore) is respected.
  5. Replay parity (invariant #3) — scoring the JSONL written by orchestrate
     reproduces the returned scorecard exactly.
  6. AgentEvent → TelemetryEvent adapter mapping.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from saboteur.agents.outcomes import AgentEvent, AgentRunResult, Outcome
from saboteur.chaos.profile import ChaosProfile
from saboteur.harness import (
    battle_royale,
    orchestrate,
    score,
    to_telemetry,
)
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RUN_ID = "harness-test-run"


def _profile(name: str = "test_chaos", seed: int = 7) -> ChaosProfile:
    return ChaosProfile(name=name, seed=seed, faults=[])


def _bound_bus() -> TelemetryBus:
    bus = TelemetryBus()
    bus.bind(asyncio.get_running_loop())
    return bus


def _result(
    agent_id: int,
    outcome: Outcome = Outcome.COMPLETED,
    tokens: int = 1000,
    steps: int = 5,
) -> AgentRunResult:
    return AgentRunResult(
        agent_id=agent_id,
        outcome=outcome,
        task_result=None,
        tokens_used=tokens,
        steps_taken=steps,
    )


def _terminal_event(
    agent_id: int,
    *,
    success: bool = True,
    outcome: str = "completed",
    tokens: int = 1000,
    steps: int = 5,
) -> AgentEvent:
    return AgentEvent(
        agent_id,
        None,
        "terminal",
        {
            "outcome": outcome,
            "success": success,
            "tokens_used": tokens,
            "steps_taken": steps,
        },
    )


class _Tracker:
    """High-water mark of concurrently running FakeAgents."""

    def __init__(self) -> None:
        self.current = 0
        self.peak = 0

    def enter(self) -> None:
        self.current += 1
        self.peak = max(self.peak, self.current)

    def exit(self) -> None:
        self.current -= 1


class FakeAgent:
    """Duck-types SaboteurAgent.run(): emits scripted events, then returns
    a scripted result or raises a scripted exception."""

    def __init__(
        self,
        agent_id: int,
        on_event,
        *,
        events: tuple[AgentEvent, ...] = (),
        result: AgentRunResult | None = None,
        raises: Exception | None = None,
        tracker: _Tracker | None = None,
        delay: float = 0.0,
    ) -> None:
        self.agent_id = agent_id
        self.on_event = on_event
        self.events = events
        self.result = result
        self.raises = raises
        self.tracker = tracker
        self.delay = delay

    async def run(self) -> AgentRunResult:
        if self.tracker is not None:
            self.tracker.enter()
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            for event in self.events:
                if self.on_event is not None:
                    self.on_event(event)
            if self.raises is not None:
                raise self.raises
            assert self.result is not None
            return self.result
        finally:
            if self.tracker is not None:
                self.tracker.exit()


def _fake_factory(specs: dict[int, dict[str, Any]]):
    """Build an AgentFactory that returns scripted FakeAgents."""

    def factory(agent_id, profile, store, on_event):
        return FakeAgent(agent_id, on_event, **specs[agent_id])

    return factory


def _tev(
    agent_id: int,
    event: str,
    *,
    step: int | None = None,
    fault: str | None = None,
    recovery: str | None = None,
    tokens_used: int | None = None,
    payload: dict[str, Any] | None = None,
    run_id: str = RUN_ID,
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
    agent_id: int, *, success: bool, tokens: int, outcome: str = "completed"
) -> TelemetryEvent:
    return _tev(
        agent_id,
        "agent_done",
        tokens_used=tokens,
        payload={"outcome": outcome, "success": success, "steps_taken": 5},
    )


# ---------------------------------------------------------------------------
# 1. Crash isolation
# ---------------------------------------------------------------------------

async def test_one_crashing_agent_never_affects_others() -> None:
    specs: dict[int, dict[str, Any]] = {
        i: {"events": (_terminal_event(i),), "result": _result(i)}
        for i in range(4)
    }
    specs[2] = {"raises": RuntimeError("boom")}

    report = await battle_royale(
        RUN_ID,
        4,
        _profile(),
        _bound_bus(),
        concurrency_limit=4,
        agent_factory=_fake_factory(specs),
    )

    assert len(report.results) == 4
    assert report.results[2].outcome == Outcome.HARD_EXCEPTION
    assert "boom" in (report.results[2].error or "")
    for i in (0, 1, 3):
        assert report.results[i].outcome == Outcome.COMPLETED
        assert report.results[i].agent_id == i

    crashed = [e for e in report.events if e.event == "agent_crashed"]
    assert len(crashed) == 1
    assert crashed[0].agent_id == 2
    assert report.events[0].event == "run_started"
    assert report.events[-1].event == "run_finished"
    assert report.events[-1].payload["outcomes"]["hard_exception"] == 1

    # The crash surfaces in the scorecard's failure-mode histogram.
    card = score(report.events, report.events, run_id=RUN_ID, profile="test_chaos")
    assert card.n_agents == 4
    assert card.failure_modes == {"hard_exception": 1}
    assert card.survival_rate == pytest.approx(3 / 4)


# ---------------------------------------------------------------------------
# 2. Exact scoring math on a hand-built event log
# ---------------------------------------------------------------------------

def _hand_built_chaos_events() -> list[TelemetryEvent]:
    return [
        _tev(-1, "run_started", payload={"n_agents": 3}),
        # Agent 0: api_error at step 2, productive retry at step 4, success.
        _tev(0, "fault_injected", step=2, fault="api_error"),
        _tev(0, "recovery_action", step=4, recovery="retry"),
        _done(0, success=True, tokens=1000),
        # Agent 1: silent_lie at step 3, never caught → wrong report.
        _tev(1, "fault_injected", step=3, fault="silent_lie"),
        _done(1, success=False, tokens=2000),
        # Agent 2: untouched, clean success.
        _done(2, success=True, tokens=1000),
        _tev(-1, "run_finished", payload={"n_agents": 3}),
    ]


def _hand_built_control_events() -> list[TelemetryEvent]:
    run_id = RUN_ID + "-control"
    return [
        _tev(-1, "run_started", payload={"n_agents": 3}, run_id=run_id),
        _done(0, success=True, tokens=1000),
        _done(1, success=True, tokens=1000),
        _done(2, success=True, tokens=1000),
        _tev(-1, "run_finished", payload={"n_agents": 3}, run_id=run_id),
    ]


def test_scoring_exact_math() -> None:
    card = score(
        _hand_built_chaos_events(),
        _hand_built_control_events(),
        run_id=RUN_ID,
        profile="flaky_friday",
        control_run_id=RUN_ID + "-control",
    )

    assert card.n_agents == 3
    assert card.survival_rate == pytest.approx(2 / 3)
    assert card.mttr_steps == pytest.approx(2.0)  # fault step 2 → recovery step 4
    assert card.recovery_breakdown == {"retry": 1}
    assert card.waste_factor == pytest.approx(4000 / 3000)
    assert card.deception_detection_rate == 0.0  # the one lied-to agent failed
    assert card.failure_modes == {}  # all outcomes were "completed"
    assert card.per_agent[0]["faults"] == ["api_error"]
    assert card.per_agent[0]["recoveries"] == ["retry"]
    assert card.per_agent[1]["faults"] == ["silent_lie"]
    assert card.per_agent[2]["success"] is True


def test_scoring_gave_up_is_not_a_recovery_for_mttr() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 1}),
        _tev(0, "fault_injected", step=2, fault="api_error"),
        _tev(0, "recovery_action", step=3, recovery="gave_up"),
        _done(0, success=False, tokens=500, outcome="silent_abandonment"),
        _tev(-1, "run_finished", payload={"n_agents": 1}),
    ]
    card = score(events, events, run_id=RUN_ID, profile="p")
    assert card.mttr_steps is None  # gave_up is not productive recovery
    assert card.recovery_breakdown == {"gave_up": 1}  # but it is counted
    assert card.failure_modes == {"silent_abandonment": 1}


# ---------------------------------------------------------------------------
# 3. calm_seas control ⇒ waste factor exactly 1.0
# ---------------------------------------------------------------------------

def test_calm_seas_control_gives_waste_factor_one() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 2}),
        _done(0, success=True, tokens=500),
        _done(1, success=True, tokens=500),
        _tev(-1, "run_finished", payload={"n_agents": 2}),
    ]
    card = score(events, events, run_id=RUN_ID, profile="calm_seas")

    assert card.waste_factor == 1.0
    assert card.survival_rate == 1.0
    assert card.mttr_steps is None  # no faults
    assert card.deception_detection_rate is None  # no silent_lie injected
    assert card.recovery_breakdown == {}
    assert card.failure_modes == {}


# ---------------------------------------------------------------------------
# 4. Concurrency limit
# ---------------------------------------------------------------------------

async def test_concurrency_limit_respected() -> None:
    tracker = _Tracker()
    specs = {
        i: {
            "events": (_terminal_event(i),),
            "result": _result(i),
            "tracker": tracker,
            "delay": 0.01,
        }
        for i in range(6)
    }

    await battle_royale(
        RUN_ID,
        6,
        _profile(),
        _bound_bus(),
        concurrency_limit=2,
        agent_factory=_fake_factory(specs),
    )
    assert tracker.peak <= 2


async def test_concurrency_zero_means_unlimited() -> None:
    tracker = _Tracker()
    specs = {
        i: {
            "events": (_terminal_event(i),),
            "result": _result(i),
            "tracker": tracker,
            "delay": 0.01,
        }
        for i in range(6)
    }

    await battle_royale(
        RUN_ID,
        6,
        _profile(),
        _bound_bus(),
        concurrency_limit=0,
        agent_factory=_fake_factory(specs),
    )
    assert tracker.peak == 6


# ---------------------------------------------------------------------------
# 5. Replay parity (invariant #3): JSONL re-scores to the same scorecard
# ---------------------------------------------------------------------------

async def test_orchestrate_replay_parity(tmp_path: Path) -> None:
    chaos_yaml = tmp_path / "chaos.yaml"
    chaos_yaml.write_text("name: fake_chaos\nseed: 7\nfaults: []\n")
    calm_yaml = tmp_path / "calm.yaml"
    calm_yaml.write_text("name: calm_seas\nseed: 0\nfaults: []\n")
    runs_dir = tmp_path / "runs"

    specs = {
        i: {
            "events": (_terminal_event(i, tokens=1000 + 100 * i),),
            "result": _result(i, tokens=1000 + 100 * i),
        }
        for i in range(2)
    }

    scorecard = await orchestrate(
        chaos_yaml,
        n_agents=2,
        runs_dir=runs_dir,
        control_profile_path=calm_yaml,
        agent_factory=_fake_factory(specs),
    )

    chaos_log = runs_dir / f"{scorecard.run_id}.jsonl"
    control_log = runs_dir / f"{scorecard.run_id}-control.jsonl"
    scorecard_json = runs_dir / f"{scorecard.run_id}.scorecard.json"
    assert chaos_log.exists()
    assert control_log.exists()
    assert scorecard_json.exists()

    replayed = score(
        read_jsonl(chaos_log),
        read_jsonl(control_log),
        run_id=scorecard.run_id,
        profile=scorecard.profile,
        control_run_id=scorecard.control_run_id,
    )
    assert replayed == scorecard
    # Both cohorts ran identical fakes → waste factor exactly 1.0.
    assert scorecard.waste_factor == 1.0
    assert scorecard.survival_rate == 1.0


# ---------------------------------------------------------------------------
# 6. AgentEvent → TelemetryEvent adapter
# ---------------------------------------------------------------------------

def test_adapter_fault_lifts_fault_field() -> None:
    event = AgentEvent(
        3, 2, "fault", {"fault": "api_error", "tool": "weather", "call_index": 1}
    )
    telemetry = to_telemetry(event, RUN_ID)
    assert telemetry is not None
    assert telemetry.event == "fault_injected"
    assert telemetry.fault == "api_error"
    assert telemetry.agent_id == 3
    assert telemetry.step == 2
    assert telemetry.run_id == RUN_ID
    assert telemetry.payload == {"tool": "weather", "call_index": 1}


def test_adapter_recovery_lifts_recovery_field() -> None:
    event = AgentEvent(1, 4, "recovery", {"kind": "retry", "after_fault": "api_error"})
    telemetry = to_telemetry(event, RUN_ID)
    assert telemetry is not None
    assert telemetry.event == "recovery_action"
    assert telemetry.recovery == "retry"
    assert telemetry.payload == {"after_fault": "api_error"}


def test_adapter_terminal_lifts_tokens() -> None:
    event = _terminal_event(0, tokens=1234)
    telemetry = to_telemetry(event, RUN_ID)
    assert telemetry is not None
    assert telemetry.event == "agent_done"
    assert telemetry.tokens_used == 1234
    assert telemetry.payload["outcome"] == "completed"
    assert telemetry.payload["success"] is True


def test_adapter_step_and_tool_call_pass_through() -> None:
    step = to_telemetry(AgentEvent(0, 1, "step_start", {}), RUN_ID)
    assert step is not None and step.event == "step_start"

    call = to_telemetry(
        AgentEvent(0, 1, "tool_call", {"tool": "weather", "sabotaged": False}),
        RUN_ID,
    )
    assert call is not None
    assert call.event == "tool_call"
    assert call.payload == {"tool": "weather", "sabotaged": False}


def test_adapter_drops_unknown_kind() -> None:
    assert to_telemetry(AgentEvent(0, None, "mystery", {}), RUN_ID) is None
