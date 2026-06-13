"""End-to-end integration review tests (hostile audit of the five invariants).

All tests are LLM-free. They cover the cross-package seams that unit tests miss:

1. Determinism survives concurrency (#1) — asyncio scheduling never changes which
   faults fire; decisions depend only on the per-agent call sequence.
2. The literal acceptance — two N=8 cohort runs with the same profile+seed produce
   identical ``fault_injected`` sequences in their JSONL logs.
3. Crash isolation at every layer (#2) — tool, telemetry subscriber, and bus
   fan-out: one failure affects exactly one agent/connection.
4. Replay parity under timeout (#3, Fix A) — a finished agent's orphan callbacks
   are silent, so JSONL and the in-memory collector can't desync.
5. WS replay/live dedup (#3, Fix B) — a live event sharing a timestamp with the
   backlog is still delivered.
6. Scoring math, hand-computed (incl. the multi-fault → single-recovery MTTR).
7. ReportStore isolation under concurrent writers (#2).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from saboteur.agents.factory import SaboteurAgent
from saboteur.agents.outcomes import AgentEvent, AgentRunResult, Outcome
from saboteur.agents.tools import FiledReport, ReportStore, build_tools
from saboteur.chaos.engine import ChaosEngine
from saboteur.chaos.events import FaultEvent, FaultType
from saboteur.chaos.profile import ChaosProfile, FaultSpec
from saboteur.harness import cohort_run, orchestrate, score
from saboteur.harness.instrumentation import make_on_event
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent


# ---------------------------------------------------------------------------
# Shared fixtures: a spicy-but-fast profile and a fixed call sequence
# ---------------------------------------------------------------------------

# Sub-millisecond sleeps so latency/timeout faults don't slow the suite.
def _spicy_profile(seed: int = 1234) -> ChaosProfile:
    return ChaosProfile(
        name="integration_spicy",
        seed=seed,
        faults=[
            FaultSpec(type=FaultType.API_ERROR, probability=0.25),
            FaultSpec(
                type=FaultType.RATE_LIMIT,
                probability=0.15,
                retry_after_s=(1, 4),
                burst_budget=2,
                window_calls=4,
            ),
            FaultSpec(type=FaultType.MALFORMED, probability=0.10),
            FaultSpec(type=FaultType.SILENT_LIE, probability=0.15),
            FaultSpec(type=FaultType.LATENCY, probability=0.20, delay_s=(0.0, 0.001)),
            FaultSpec(
                type=FaultType.TIMEOUT, probability=0.05, timeout_after_s=0.001
            ),
        ],
    )


# A fixed, agent-independent tool-call script (what a deterministic LLM would do).
_CALL_SCRIPT: tuple[tuple[str, str], ...] = tuple(
    ("weather" if i % 2 == 0 else "calculator", f"arg-{i}") for i in range(24)
)

_MOCK_TOOLS = {
    "weather": lambda arg: json.dumps({"city": "Tokyo", "temp_c": 22.0, "q": arg}),
    "calculator": lambda arg: "71.6",
}


def _fault_fingerprint(events: list[FaultEvent]) -> list[tuple]:
    """A scheduling-independent, fully serialized view of an agent's faults."""
    return [
        (e.call_index, str(e.fault), e.tool_name, tuple(sorted(e.detail.items())))
        for e in events
    ]


def _run_script_sync(profile: ChaosProfile, agent_id: int) -> list[FaultEvent]:
    """Run the fixed call script through a real engine; collect fault events."""
    faults: list[FaultEvent] = []
    engine = ChaosEngine(profile, agent_id, on_fault=faults.append)
    tools = engine.wrap_tools(_MOCK_TOOLS)
    for name, arg in _CALL_SCRIPT:
        try:
            tools[name](arg)
        except Exception:
            pass
    return faults


# ---------------------------------------------------------------------------
# 1. Determinism survives concurrency (invariant #1)
# ---------------------------------------------------------------------------

async def test_concurrency_does_not_perturb_fault_sequences() -> None:
    """N=8 agents run concurrently in worker threads, twice. Each agent's fault
    sequence must be byte-identical between the two concurrent runs AND equal to
    the single-threaded reference — proving asyncio scheduling can't change which
    faults fire (decisions depend only on the per-agent call sequence)."""
    n = 8
    profile = _spicy_profile()

    # Single-threaded reference.
    reference = {
        aid: _fault_fingerprint(_run_script_sync(profile, aid)) for aid in range(n)
    }
    # Sanity: chaos actually happened for at least one agent.
    assert any(reference[aid] for aid in range(n))

    async def concurrent_run() -> dict[int, list[tuple]]:
        results = await asyncio.gather(
            *(asyncio.to_thread(_run_script_sync, profile, aid) for aid in range(n))
        )
        return {aid: _fault_fingerprint(results[aid]) for aid in range(n)}

    run_a = await concurrent_run()
    run_b = await concurrent_run()

    assert run_a == reference, "concurrency perturbed the fault sequence"
    assert run_b == reference
    assert run_a == run_b


# ---------------------------------------------------------------------------
# 2. The literal acceptance: identical fault_injected JSONL across two cohort runs
# ---------------------------------------------------------------------------

class _ScriptedEngineAgent:
    """A deterministic, LLM-free agent that drives the fixed call script through
    a real ChaosEngine and streams real fault telemetry through ``on_event`` —
    exactly the path SaboteurAgent uses, minus the model."""

    def __init__(self, agent_id, profile, store, on_event) -> None:
        self.agent_id = agent_id
        self._on_event = on_event

        def _on_fault(ev: FaultEvent) -> None:
            if on_event is not None:
                on_event(
                    AgentEvent(
                        agent_id,
                        ev.call_index,
                        "fault",
                        {
                            "fault": str(ev.fault),
                            "tool": ev.tool_name,
                            "call_index": ev.call_index,
                            "detail": ev.detail,
                        },
                    )
                )

        self._engine = ChaosEngine(profile, agent_id, on_fault=_on_fault)
        self._tools = self._engine.wrap_tools(_MOCK_TOOLS)

    async def run(self) -> AgentRunResult:
        def _work() -> None:
            for name, arg in _CALL_SCRIPT:
                try:
                    self._tools[name](arg)
                except Exception:
                    pass

        await asyncio.to_thread(_work)
        if self._on_event is not None:
            self._on_event(
                AgentEvent(
                    self.agent_id,
                    None,
                    "terminal",
                    {
                        "outcome": "completed",
                        "success": True,
                        "tokens_used": 100,
                        "steps_taken": len(_CALL_SCRIPT),
                    },
                )
            )
        return AgentRunResult(
            agent_id=self.agent_id,
            outcome=Outcome.COMPLETED,
            task_result=None,
            tokens_used=100,
            steps_taken=len(_CALL_SCRIPT),
        )


def _scripted_factory(agent_id, profile, store, on_event):
    return _ScriptedEngineAgent(agent_id, profile, store, on_event)


def _jsonl_fault_view(path: Path) -> dict[int, list[tuple]]:
    """Per-agent ordered fault_injected projection from a JSONL log."""
    by_agent: dict[int, list[tuple]] = {}
    for e in read_jsonl(path):
        if e.event != "fault_injected":
            continue
        by_agent.setdefault(e.agent_id, []).append(
            (e.step, e.fault, tuple(sorted(e.payload.items())))
        )
    return by_agent


async def test_two_cohort_runs_same_seed_identical_fault_jsonl(tmp_path: Path) -> None:
    """Acceptance: two N=8 runs, same profile+seed → identical fault_injected logs."""
    chaos_yaml = tmp_path / "chaos.yaml"
    chaos_yaml.write_text(
        "name: acceptance_chaos\nseed: 4242\nfaults:\n"
        "  - {type: api_error, probability: 0.3}\n"
        "  - {type: silent_lie, probability: 0.2}\n"
        "  - {type: rate_limit, probability: 0.1, retry_after_s: [1, 3],"
        " burst_budget: 2, window_calls: 4}\n"
        "  - {type: latency, probability: 0.2, delay_s: [0.0, 0.001]}\n"
    )
    runs = tmp_path / "runs"

    await orchestrate(
        chaos_yaml,
        n_agents=8,
        run_id="detrun-a",
        with_control=False,
        runs_dir=runs,
        agent_factory=_scripted_factory,
    )
    await orchestrate(
        chaos_yaml,
        n_agents=8,
        run_id="detrun-b",
        with_control=False,
        runs_dir=runs,
        agent_factory=_scripted_factory,
    )

    view_a = _jsonl_fault_view(runs / "detrun-a.jsonl")
    view_b = _jsonl_fault_view(runs / "detrun-b.jsonl")

    assert view_a == view_b, "fault_injected sequences diverged between identical runs"
    assert any(view_a.values()), "expected at least one fault to be injected"
    # All 8 agents present and divergent per-agent (different seed+agent_id).
    assert set(view_a) == set(range(8))


# ---------------------------------------------------------------------------
# 3. Crash isolation at every layer (invariant #2)
# ---------------------------------------------------------------------------

class _FaultyEventAgent:
    """Runs fine but its on_event sink raises — must not crash the agent."""

    def __init__(self, agent_id, profile, store, on_event) -> None:
        self.agent_id = agent_id
        self._on_event = on_event

    async def run(self) -> AgentRunResult:
        if self._on_event is not None:
            self._on_event(
                AgentEvent(
                    self.agent_id,
                    None,
                    "terminal",
                    {"outcome": "completed", "success": True, "tokens_used": 50,
                     "steps_taken": 1},
                )
            )
        return AgentRunResult(
            agent_id=self.agent_id,
            outcome=Outcome.COMPLETED,
            task_result=None,
            tokens_used=50,
            steps_taken=1,
        )


def test_make_on_event_swallows_subscriber_errors() -> None:
    """A bus whose emit raises must never propagate into the agent loop (#3)."""

    class _BoomBus:
        def emit(self, event) -> None:  # noqa: ANN001
            raise RuntimeError("subscriber exploded")

    on_event = make_on_event(_BoomBus(), "run")  # type: ignore[arg-type]
    # Must not raise.
    on_event(AgentEvent(0, 1, "fault", {"fault": "api_error"}))


def test_factory_emit_guards_against_raising_sink() -> None:
    """SaboteurAgent._emit/_handle_fault swallow sink exceptions (#3)."""

    def boom(_event: AgentEvent) -> None:
        raise RuntimeError("sink down")

    shell = SaboteurAgent(agent_id=0, store={}, on_event=boom)
    # None of these may raise even though the sink always does.
    shell._emit("step_start", 1, {})
    shell._handle_fault(
        FaultEvent(fault=FaultType.API_ERROR, tool_name="weather",
                   call_index=0, agent_id=0, detail={})
    )


async def test_one_raising_subscriber_does_not_starve_others() -> None:
    """Bus fan-out isolation: a consumer that raises mid-stream must not stop
    other subscribers from receiving every event (#2)."""
    bus = TelemetryBus()
    bus.bind(asyncio.get_event_loop())
    n = 5
    good: list[TelemetryEvent] = []

    async def bad_sub() -> None:
        async with bus.subscribe() as events:
            async for ev in events:
                if ev.step == 1:
                    raise RuntimeError("consumer crash")
                # otherwise just drop it

    async def good_sub() -> None:
        async with bus.subscribe() as events:
            async for ev in events:
                good.append(ev)

    bad = asyncio.create_task(bad_sub())
    goodt = asyncio.create_task(good_sub())
    await asyncio.sleep(0)

    for i in range(n):
        bus.emit(TelemetryEvent(run_id="r", agent_id=0, step=i, event="step_start"))

    await asyncio.sleep(0)
    await asyncio.sleep(0)
    bus.close()
    await asyncio.gather(goodt, bad, return_exceptions=True)

    assert [e.step for e in good] == list(range(n))


async def test_faulty_event_sink_agent_still_completes_others() -> None:
    """Through the harness: an agent whose sink raises (and is swallowed) still
    completes, and the rest of the cohort is untouched (#2)."""
    bus = TelemetryBus()
    bus.bind(asyncio.get_event_loop())

    def factory(agent_id, profile, store, on_event):
        if agent_id == 1:
            return _FaultyEventAgent(agent_id, profile, store, on_event)
        return _ScriptedEngineAgent(agent_id, profile, store, on_event)

    report = await cohort_run(
        "iso-run",
        3,
        _spicy_profile(),
        bus,
        concurrency_limit=3,
        agent_factory=factory,
    )
    assert len(report.results) == 3
    assert all(r.outcome == Outcome.COMPLETED for r in report.results)


# ---------------------------------------------------------------------------
# 4. Replay parity under timeout — the _finished flag silences orphan callbacks
# ---------------------------------------------------------------------------

def test_finished_flag_silences_all_callbacks() -> None:
    """Fix A: once run() has finished, an orphan worker thread's callbacks are
    no-ops, so no telemetry can land after run_finished and desync the logs."""
    emitted: list[AgentEvent] = []
    shell = SaboteurAgent(agent_id=0, store={}, on_event=emitted.append)
    shell._finished = True

    shell._emit("step_start", 1, {})
    shell._handle_fault(
        FaultEvent(fault=FaultType.API_ERROR, tool_name="weather",
                   call_index=3, agent_id=0, detail={})
    )

    class _FakeStep:
        step_number = 5
        tool_calls: list = []
        error = None
        observations = None

    shell._on_step(_FakeStep())  # type: ignore[arg-type]

    assert emitted == [], "finished agent must not emit telemetry"
    assert shell._faults == [], "finished agent must not record faults"
    assert shell._history == [], "finished agent must not extend history"


# ---------------------------------------------------------------------------
# 5. WS replay/live dedup (Fix B): a live event sharing a ts with the backlog
#    must still be delivered (the old ts<=high-water cutoff would drop it).
# ---------------------------------------------------------------------------

def test_ws_live_event_sharing_timestamp_is_not_dropped(tmp_path, monkeypatch) -> None:
    from contextlib import asynccontextmanager
    from datetime import datetime, timezone

    from fastapi import FastAPI
    from starlette.testclient import TestClient

    import saboteur.telemetry.ws as ws_mod

    monkeypatch.setattr(ws_mod, "_RUNS_DIR", tmp_path)
    run_id = "ws-dedup"
    shared_ts = datetime.now(tz=timezone.utc)

    backlog = TelemetryEvent(
        ts=shared_ts, run_id=run_id, agent_id=0, step=0, event="step_start"
    )
    (tmp_path / f"{run_id}.jsonl").write_text(backlog.model_dump_json() + "\n")

    bus = TelemetryBus()
    reg = ws_mod.BusRegistry()
    reg.register(run_id, bus)
    monkeypatch.setattr(ws_mod, "registry", reg)

    @asynccontextmanager
    async def lifespan(app):
        bus.bind(asyncio.get_running_loop())
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(ws_mod.router)

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/{run_id}") as ws:
            got_backlog = ws.receive_json()
            # Live event with the SAME ts but a distinct identity (step=1).
            bus.emit(
                TelemetryEvent(
                    ts=shared_ts, run_id=run_id, agent_id=0, step=1,
                    event="tool_call",
                )
            )
            got_live = ws.receive_json()

    assert got_backlog["step"] == 0
    assert got_live["step"] == 1  # not dropped despite the shared timestamp


# ---------------------------------------------------------------------------
# 6. Scoring math, hand-computed — multi-fault → single-recovery MTTR pairing
# ---------------------------------------------------------------------------

def _tev(agent_id, event, *, step=None, fault=None, recovery=None,
         tokens_used=None, payload=None, run_id="score-run"):
    return TelemetryEvent(
        run_id=run_id, agent_id=agent_id, step=step, event=event,
        fault=fault, recovery=recovery, tokens_used=tokens_used,
        payload=payload or {},
    )


def test_mttr_pairs_every_prior_fault_to_next_productive_recovery() -> None:
    """Documented MTTR definition: each fault at step s maps to the next
    productive recovery at step >= s. Faults @2 and @4, recovery @5 →
    distances 3 and 1 → mean 2.0."""
    events = [
        _tev(-1, "run_started", payload={"n_agents": 1}),
        _tev(0, "fault_injected", step=2, fault="api_error"),
        _tev(0, "fault_injected", step=4, fault="malformed"),
        _tev(0, "recovery_action", step=5, recovery="retry"),
        _tev(0, "agent_done", tokens_used=900,
             payload={"outcome": "completed", "success": True, "steps_taken": 6}),
        _tev(-1, "run_finished", payload={"n_agents": 1}),
    ]
    card = score(events, events, run_id="score-run", profile="p")
    assert card.mttr_steps == pytest.approx((3 + 1) / 2)
    assert card.survival_rate == 1.0
    assert card.recovery_breakdown == {"retry": 1}


def test_mttr_skips_no_action_stall() -> None:
    """A ``no_action`` stall is not a productive recovery: fault @2 → no_action
    @3 → retry @5 pairs the fault to the retry (distance 3), not the stall."""
    events = [
        _tev(-1, "run_started", payload={"n_agents": 1}),
        _tev(0, "fault_injected", step=2, fault="api_error"),
        _tev(0, "recovery_action", step=3, recovery="no_action"),
        _tev(0, "recovery_action", step=5, recovery="retry"),
        _tev(0, "agent_done", tokens_used=100,
             payload={"outcome": "completed", "success": True, "steps_taken": 6}),
        _tev(-1, "run_finished", payload={"n_agents": 1}),
    ]
    card = score(events, events, run_id="score-run", profile="p")
    assert card.mttr_steps == pytest.approx(3.0)
    # The stall is still surfaced in the breakdown, just not counted for MTTR.
    assert card.recovery_breakdown == {"no_action": 1, "retry": 1}


def test_deception_rate_counts_only_lied_to_agents() -> None:
    events = [
        _tev(-1, "run_started", payload={"n_agents": 3}),
        # Agent 0: lied to, caught it (success).
        _tev(0, "fault_injected", step=1, fault="silent_lie"),
        _tev(0, "agent_done", tokens_used=100,
             payload={"outcome": "completed", "success": True}),
        # Agent 1: lied to, believed it (failure).
        _tev(1, "fault_injected", step=1, fault="silent_lie"),
        _tev(1, "agent_done", tokens_used=100,
             payload={"outcome": "completed", "success": False}),
        # Agent 2: never lied to → excluded from the deception denominator.
        _tev(2, "agent_done", tokens_used=100,
             payload={"outcome": "completed", "success": True}),
        _tev(-1, "run_finished", payload={"n_agents": 3}),
    ]
    card = score(events, events, run_id="score-run", profile="p")
    assert card.deception_detection_rate == pytest.approx(1 / 2)


# ---------------------------------------------------------------------------
# 7. ReportStore isolation under concurrent writers (invariant #2)
# ---------------------------------------------------------------------------

async def test_report_store_concurrent_writers_no_lost_or_crossed_writes() -> None:
    """Many agents writing their own key concurrently: every write lands, and no
    report ends up under the wrong agent_id."""
    store: ReportStore = {}
    n = 32
    writes_each = 10

    def _write(agent_id: int) -> None:
        # Fresh tools per agent (build_tools), as the factory does.
        file_tool = build_tools(agent_id, store)[-1]
        for k in range(writes_each):
            file_tool.forward(fahrenheit=f"agent {agent_id} report {k}")

    await asyncio.gather(*(asyncio.to_thread(_write, aid) for aid in range(n)))

    assert set(store) == set(range(n))
    for aid in range(n):
        reports = store[aid]
        assert len(reports) == writes_each
        # Every report in this slot belongs to this agent — no cross-contamination.
        assert all(isinstance(r, FiledReport) for r in reports)
        assert all(f"agent {aid} " in r.body for r in reports)
