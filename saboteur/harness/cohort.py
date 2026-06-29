"""Cohort run — run N identical agents concurrently under one chaos profile.

Crash isolation (invariant #2): every agent gets its own factory-built
``SaboteurAgent`` (own ChaosEngine, own tools, own history); the only shared
object is the ``ReportStore`` dict, which each agent writes under its own
``agent_id`` key. Each run is guarded so an unexpected exception becomes an
``agent_crashed`` telemetry event plus a synthesized ``HARD_EXCEPTION``
result — never an unhandled error — and ``asyncio.gather`` runs with
``return_exceptions=True`` as a second belt.

Determinism (invariant #1): per-agent event *content* is fully determined by
(profile, seed, agent_id) — the engine RNG is seeded per agent. The
*interleaving* of events across agents in the bus stream is scheduling-
dependent and therefore not deterministic; scoring is order-insensitive
across agents (it groups by ``agent_id``).

Bounded wall-clock (invariant #5): each ``SaboteurAgent.run()`` is capped by
``settings.agent_timeout_s`` and the semaphore admits at most
``concurrency_limit`` agents at a time, so the whole cohort finishes within
~ceil(N / limit) × timeout.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass, field
from typing import Protocol

from saboteur.agents.factory import OnEvent, build_agent
from saboteur.agents.oracle import Oracle
from saboteur.agents.outcomes import AgentRunResult, Outcome
from saboteur.agents.tools import ReportStore
from saboteur.chaos.profile import ChaosProfile
from saboteur.config import get_settings
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.schema import EventKind, TelemetryEvent

from .instrumentation import make_on_event

# How long to wait for the event collector to drain after run_finished. Only
# trips if the bus was never bound (emits silently dropped) — a caller bug.
_COLLECTOR_DRAIN_TIMEOUT_S = 10.0


class RunnableAgent(Protocol):
    """What cohort_run needs from an agent: just an async run()."""

    async def run(self) -> AgentRunResult: ...


class AgentFactory(Protocol):
    """Factory seam: production is :func:`build_agent`; tests inject a FakeAgent.

    Declared as a Protocol (not a bare ``Callable``) so the **keyword-only**
    ``oracle`` argument is part of the type — ``runner.orchestrate`` binds it via
    ``functools.partial(agent_factory, oracle=…)`` and that must type-check
    (otherwise the oracle seam drifts silently — the WP2/PWP1 interface-drift bug).
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
    """Everything one cohort produced: per-agent results + the event stream."""

    run_id: str
    profile_name: str
    seed: int
    n_agents: int
    results: list[AgentRunResult] = field(default_factory=list)
    events: list[TelemetryEvent] = field(default_factory=list)


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
    on_event = make_on_event(bus, run_id)

    # Collect this run's events from our own subscription, started before
    # run_started is emitted so the report misses nothing. The collector
    # stops itself at run_finished (the bus stays open for other subscribers).
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
                    # A malformed event must never tear down the run (#2). Keep
                    # draining; the worst case is one dropped collected event.
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

        raw = await asyncio.gather(
            *(_run_one(i) for i in range(n_agents)), return_exceptions=True
        )
        # _run_one already converts exceptions; this handles anything that
        # slipped past it (e.g. CancelledError-adjacent edge cases).
        results = [
            r if isinstance(r, AgentRunResult) else _crashed(bus, run_id, i, r)
            for i, r in enumerate(raw)
        ]

        outcome_counts = Counter(str(r.outcome) for r in results)
        bus.emit(
            _run_event(
                run_id,
                "run_finished",
                {"n_agents": n_agents, "outcomes": dict(outcome_counts)},
            )
        )

        try:
            await asyncio.wait_for(collector, timeout=_COLLECTOR_DRAIN_TIMEOUT_S)
        except asyncio.TimeoutError:
            # Bus never delivered run_finished (unbound bus?) — keep what we
            # have rather than hanging the run.
            collector.cancel()
        except Exception:
            # The collector should never raise (its body is guarded), but if it
            # somehow does, that must not escape the run (#2): keep what we have.
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
    )


def _run_event(run_id: str, kind: EventKind, payload: dict) -> TelemetryEvent:
    """A run-lifecycle event; agent_id -1 means 'the run itself'."""
    return TelemetryEvent(
        run_id=run_id, agent_id=-1, step=None, event=kind, payload=payload
    )


def _crashed(
    bus: TelemetryBus, run_id: str, agent_id: int, exc: BaseException
) -> AgentRunResult:
    """Convert an escaped exception into telemetry + a synthesized result."""
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
