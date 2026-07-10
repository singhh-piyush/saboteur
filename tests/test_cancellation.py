"""Cancellation tests — every exit path emits exactly one terminal.

Regression for the hell_mode N=50 GPU run ``hell_mode-20260703T002129-ee891b``:
STOP RUN cancelled the orchestrate task ~70 s in; ``CancelledError`` (a
``BaseException``) bypassed every ``except Exception`` arm, so 10 in-flight
agents emitted no terminal, ``run_finished`` was never emitted, and no
scorecard was persisted. These tests pin the fix:

1. ``SaboteurAgent.run()`` cancelled mid-run emits exactly one terminal
   (``cancelled: true``, outcome ``timeout``) and still propagates.
2. Step-cap exhaustion mid-recovery emits exactly one terminal (the normal
   path — pins that the original hypothesis path was never broken).
3. A cancelled cohort still emits ``run_finished`` and persists a scorecard;
   an agent that never emitted a terminal is synthesized into one, so it
   lands in ``failure_modes`` instead of silently vanishing (invariant #2).
4. Replay parity for the cancelled run's JSONL (invariant #3).
5. A STOP during the *control* stage never launches the chaos cohort and
   writes no scorecard.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from saboteur.agents.factory import SaboteurAgent
from saboteur.agents.outcomes import AgentEvent, AgentRunResult, Outcome, StepRecord
from saboteur.harness import orchestrate, score
from saboteur.telemetry.jsonl import read_jsonl

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _BlockingLoopAgent:

    def __init__(self) -> None:
        self.release = threading.Event()
        self.step_number = 3

    def run(self, prompt: str, return_full_result: bool = False) -> Any:
        self.release.wait(timeout=10.0)
        return None


class _StepCapAgent:

    step_number = 15

    def run(self, prompt: str, return_full_result: bool = False) -> Any:
        return SimpleNamespace(state="max_steps_error", output=None, token_usage=None)


def _rec(step: int, tool: str | None, *, faulted: bool = False) -> StepRecord:
    return StepRecord(
        step=step,
        tool_name=tool,
        arguments={"q": step},
        faulted=faulted,
        fault_types=("api_error",) if faulted else (),
        errored=faulted,
        observation=None,
    )


# ---------------------------------------------------------------------------
# 1. Agent-level: cancel mid-run emits exactly one terminal, then propagates
# ---------------------------------------------------------------------------


async def test_cancelled_agent_emits_exactly_one_terminal() -> None:
    events: list[AgentEvent] = []
    shell = SaboteurAgent(agent_id=0, store={}, on_event=events.append)
    stub = _BlockingLoopAgent()
    shell.agent = stub  # type: ignore[assignment]

    task = asyncio.create_task(shell.run())
    await asyncio.sleep(0.05)  # let the to_thread worker start
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    terminals = [e for e in events if e.kind == "terminal"]
    assert len(terminals) == 1
    payload = terminals[0].data
    assert payload["cancelled"] is True
    assert payload["success"] is False
    assert payload["outcome"] == str(Outcome.TIMEOUT)
    assert "not judged" in payload["oracle_detail"]
    stub.release.set()
    await asyncio.sleep(0.05)
    assert [e for e in events if e.kind == "terminal"] == terminals


# ---------------------------------------------------------------------------
# 2. Agent-level: step-cap exhaustion mid-recovery emits exactly one terminal
# ---------------------------------------------------------------------------


async def test_step_cap_mid_recovery_emits_exactly_one_terminal() -> None:
    events: list[AgentEvent] = []
    shell = SaboteurAgent(agent_id=17, store={}, on_event=events.append)
    shell.agent = _StepCapAgent()  # type: ignore[assignment]
    shell._history.extend(
        [_rec(s, "weather") for s in range(1, 14)]
        + [_rec(14, "weather", faulted=True), _rec(15, "web_search")]
    )

    result: AgentRunResult = await shell.run()

    terminals = [e for e in events if e.kind == "terminal"]
    assert len(terminals) == 1
    assert terminals[0].data["outcome"] == str(Outcome.SILENT_ABANDONMENT)
    assert result.outcome == Outcome.SILENT_ABANDONMENT
    assert result.steps_taken == 15


# ---------------------------------------------------------------------------
# 3+4. Cohort-level: a cancelled cohort still scores, persists, and replays
# ---------------------------------------------------------------------------


class _QuickAgent:
    def __init__(self, agent_id: int, on_event: Any, done: set[int]) -> None:
        self.agent_id = agent_id
        self.on_event = on_event
        self.done = done

    async def run(self) -> AgentRunResult:
        self.on_event(
            AgentEvent(
                self.agent_id,
                None,
                "terminal",
                {
                    "outcome": "completed",
                    "success": True,
                    "tokens_used": 1000,
                    "steps_taken": 5,
                },
            )
        )
        self.done.add(self.agent_id)
        return AgentRunResult(
            agent_id=self.agent_id,
            outcome=Outcome.COMPLETED,
            task_result=None,
            tokens_used=1000,
            steps_taken=5,
        )


class _HangingAgent:
    # Hangs forever and — deliberately — emits no terminal when cancelled.

    def __init__(self, agent_id: int) -> None:
        self.agent_id = agent_id

    async def run(self) -> AgentRunResult:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")


def _write_profiles(tmp_path: Path) -> tuple[Path, Path]:
    chaos = tmp_path / "chaos.yaml"
    chaos.write_text("name: fake_chaos\nseed: 7\nfaults: []\n")
    calm = tmp_path / "calm.yaml"
    calm.write_text("name: calm_seas\nseed: 0\nfaults: []\n")
    return chaos, calm


async def test_cancelled_cohort_scores_and_persists(tmp_path: Path) -> None:
    chaos_yaml, _ = _write_profiles(tmp_path)
    runs_dir = tmp_path / "runs"
    done: set[int] = set()

    def factory(agent_id, profile, store, on_event, oracle=None):
        if agent_id == 2:
            return _HangingAgent(agent_id)
        return _QuickAgent(agent_id, on_event, done)

    task = asyncio.create_task(
        orchestrate(
            chaos_yaml,
            n_agents=3,
            runs_dir=runs_dir,
            with_control=False,
            agent_factory=factory,
        )
    )
    for _ in range(400):
        if len(done) == 2:
            break
        await asyncio.sleep(0.005)
    assert len(done) == 2
    task.cancel()

    card = await task

    scorecard_path = runs_dir / f"{card.run_id}.scorecard.json"
    chaos_log = runs_dir / f"{card.run_id}.jsonl"
    assert scorecard_path.exists()

    events = read_jsonl(chaos_log)
    finished = [e for e in events if e.event == "run_finished"]
    assert len(finished) == 1
    assert finished[0].payload.get("cancelled") is True

    dones = [e for e in events if e.event == "agent_done"]
    assert sorted(e.agent_id for e in dones) == [0, 1, 2]
    synthesized = next(e for e in dones if e.agent_id == 2)
    assert synthesized.payload["cancelled"] is True
    assert synthesized.payload["synthesized"] is True

    assert card.n_agents == 3
    assert card.failure_modes == {str(Outcome.TIMEOUT): 1}
    assert card.survival_rate == pytest.approx(2 / 3)
    assert card.per_agent[2]["success"] is False

    replayed = score(
        events,
        [],
        run_id=card.run_id,
        profile=card.profile,
        control_run_id=card.control_run_id,
    )
    assert replayed == card


# ---------------------------------------------------------------------------
# 5. A STOP during the control stage never launches the chaos cohort
# ---------------------------------------------------------------------------


async def test_cancel_during_control_stage_propagates(tmp_path: Path) -> None:
    chaos_yaml, calm_yaml = _write_profiles(tmp_path)
    runs_dir = tmp_path / "runs"

    def factory(agent_id, profile, store, on_event, oracle=None):
        return _HangingAgent(agent_id)

    task = asyncio.create_task(
        orchestrate(
            chaos_yaml,
            n_agents=2,
            runs_dir=runs_dir,
            control_profile_path=calm_yaml,
            agent_factory=factory,
        )
    )
    for _ in range(400):
        if next(runs_dir.glob("*-control.jsonl"), None) is not None:
            break
        await asyncio.sleep(0.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert list(runs_dir.glob("*.scorecard.json")) == []
    control_log = next(runs_dir.glob("*-control.jsonl"))
    chaos_logs = [
        p for p in runs_dir.glob("*.jsonl") if not p.name.endswith("-control.jsonl")
    ]
    assert chaos_logs == []
    control_events = read_jsonl(control_log)
    assert [e for e in control_events if e.event == "run_finished"]
    assert len([e for e in control_events if e.event == "agent_done"]) == 2
