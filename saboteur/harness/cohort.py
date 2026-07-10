"""Cohort run orchestration.

Runs N identical agents concurrently under one chaos profile.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass, field
from typing import Protocol

from saboteur.agents.factory import OnEvent, build_agent
from saboteur.agents.oracle import Oracle
from saboteur.agents.outcomes import AgentEvent, AgentRunResult, Outcome
from saboteur.agents.tools import ReportStore
from saboteur.chaos.profile import ChaosProfile
from saboteur.config import get_settings
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.schema import EventKind, TelemetryEvent

from .instrumentation import make_on_event

# drain timeout for event collector to prevent hanging if bus is unbound
_COLLECTOR_DRAIN_TIMEOUT_S = 10.0


class RunnableAgent(Protocol):
    # what cohort_run needs from an agent: just an async run()

    async def run(self) -> AgentRunResult: ...


class AgentFactory(Protocol):
    """Factory seam for producing runnable agents.

    Declared as a Protocol to ensure oracle argument type-checking.
    """

    def __call__(
        self,
        agent_id: int,
        profile: ChaosProfile,
        store: ReportStore,
        on_event: OnEvent | None = None,
        *,
        oracle: Oracle | None = None,
    ) -> RunnableAgent: ...


@dataclass
class RunReport:
    # everything one cohort produced: per-agent results + the event stream

    run_id: str
    profile_name: str
    seed: int
    n_agents: int
    results: list[AgentRunResult] = field(default_factory=list)
    events: list[TelemetryEvent] = field(default_factory=list)
    # true if the run was cancelled externally
    cancelled: bool = False


async def cohort_run(
    run_id: str,
    n_agents: int,
    profile: ChaosProfile,
    bus: TelemetryBus,
    *,
    concurrency_limit: int | None = None,
    agent_factory: AgentFactory = build_agent,
) -> RunReport:
    """Run ``n_agents`` identical agents concurrently under *profile*.

    Args:
        run_id: Stamped onto every telemetry event.
        n_agents: Cohort size (agent ids ``0..n_agents-1``).
        profile: Chaos profile; agent ``i`` derives its faults from
            ``profile.seed + i`` inside its own ChaosEngine.
        bus: A **bound** TelemetryBus for this run. The bus is not closed
            here — the caller owns its lifecycle (other subscribers, e.g.
            the JSONL writer and WebSocket clients, may still be attached).
        concurrency_limit: Max agents running at once; ``None`` reads
            ``settings.concurrency_limit``; ``0`` means unlimited (MI300X).
        agent_factory: Test seam; defaults to :func:`build_agent`.

    Returns:
        A :class:`RunReport` with one result per agent (same order as agent
        ids) and every telemetry event this run emitted.
    """
    settings = get_settings()
    limit = settings.concurrency_limit if concurrency_limit is None else concurrency_limit
    semaphore = asyncio.Semaphore(limit) if limit > 0 else None

    store: ReportStore = {}
    base_on_event = make_on_event(bus, run_id)

    # track agents that emitted terminal to synthesize missing ones on cancellation
    seen_terminal: set[int] = set()

    def on_event(event: AgentEvent) -> None:
        if event.kind == "terminal":
            seen_terminal.add(event.agent_id)
        base_on_event(event)

    # subscription starts before run_started to capture all events
    events: list[TelemetryEvent] = []
    subscribed = asyncio.Event()

    async def _collect() -> None:
        async with bus.subscribe() as stream:
            subscribed.set()
            async for event in stream:
                try:
                    if event.run_id != run_id:
                        continue
                    events.append(event)
                    if event.event == "run_finished":
                        return
                except Exception:
                    # ignore malformed events to prevent run teardown
                    continue

    collector = asyncio.create_task(_collect())
    await subscribed.wait()

    try:
        bus.emit(
            _run_event(
                run_id,
                "run_started",
                {
                    "profile": profile.name,
                    "seed": profile.seed,
                    "n_agents": n_agents,
                },
            )
        )

        async def _run_one(agent_id: int) -> AgentRunResult:
            try:
                agent = agent_factory(agent_id, profile, store, on_event)
                if semaphore is None:
                    return await agent.run()
                async with semaphore:
                    return await agent.run()
            except Exception as exc:
                return _crashed(bus, run_id, agent_id, exc)

        cancelled = False
        try:
            raw = await asyncio.gather(
                *(_run_one(i) for i in range(n_agents)), return_exceptions=True
            )
        except asyncio.CancelledError:
            # handle external cancellation and return partial report for scoring
            cancelled = True
            raw = []

        if cancelled:
            # synthesize terminal for agents that did not start before cancellation
            for agent_id in range(n_agents):
                if agent_id in seen_terminal:
                    continue
                bus.emit(
                    TelemetryEvent(
                        run_id=run_id,
                        agent_id=agent_id,
                        step=None,
                        event="agent_done",
                        payload={
                            "outcome": str(Outcome.TIMEOUT),
                            "success": False,
                            "cancelled": True,
                            "synthesized": True,
                            "tokens_used": 0,
                            "steps_taken": 0,
                        },
                    )
                )

        # handle any exceptions that escaped _run_one
        results = [
            r if isinstance(r, AgentRunResult) else _crashed(bus, run_id, i, r)
            for i, r in enumerate(raw)
        ]

        outcome_counts = Counter(str(r.outcome) for r in results)
        finished_payload: dict = {"n_agents": n_agents, "outcomes": dict(outcome_counts)}
        if cancelled:
            finished_payload["cancelled"] = True
        bus.emit(_run_event(run_id, "run_finished", finished_payload))

        try:
            await asyncio.wait_for(collector, timeout=_COLLECTOR_DRAIN_TIMEOUT_S)
        except asyncio.TimeoutError:
            # keep partial events if run_finished is never received
            collector.cancel()
        except asyncio.CancelledError:
            # ignore cancellation during drain
            collector.cancel()
        except Exception:
            # ignore collector exceptions
            collector.cancel()
    finally:
        if not collector.done():
            collector.cancel()

    return RunReport(
        run_id=run_id,
        profile_name=profile.name,
        seed=profile.seed,
        n_agents=n_agents,
        results=results,
        events=events,
        cancelled=cancelled,
    )


def _run_event(run_id: str, kind: EventKind, payload: dict) -> TelemetryEvent:
    # a run-lifecycle event; agent_id -1 is the run itself
    return TelemetryEvent(
        run_id=run_id, agent_id=-1, step=None, event=kind, payload=payload
    )


def _crashed(
    bus: TelemetryBus, run_id: str, agent_id: int, exc: BaseException
) -> AgentRunResult:
    # convert an escaped exception into telemetry + a synthesized result
    bus.emit(
        TelemetryEvent(
            run_id=run_id,
            agent_id=agent_id,
            step=None,
            event="agent_crashed",
            payload={"error": repr(exc)},
        )
    )
    return AgentRunResult(
        agent_id=agent_id,
        outcome=Outcome.HARD_EXCEPTION,
        task_result=None,
        tokens_used=0,
        steps_taken=0,
        error=repr(exc),
    )
