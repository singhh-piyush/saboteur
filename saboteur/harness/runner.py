"""Run orchestration — the single entrypoint the API layer calls.

``orchestrate()`` runs a paired control cohort (calm_seas) and a chaos
cohort, each with its own TelemetryBus and per-event-flushed JSONL log
(``runs/{run_id}-control.jsonl`` / ``runs/{run_id}.jsonl``), registers the
live bus for ``/ws/{run_id}`` streaming, scores the two event streams, and
persists ``runs/{run_id}.scorecard.json``.

A prior control :class:`RunReport` can be passed in to skip re-running the
baseline (cloud credits are scarce — re-use the control cohort when only the
chaos profile changes).
"""

from __future__ import annotations

import asyncio
import functools
import uuid
from datetime import datetime, timezone
from pathlib import Path

from saboteur.chaos.profile import ChaosProfile, load_profile
from saboteur.config import get_settings
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import JsonlWriter
from saboteur.telemetry.ws import registry

from .cohort import AgentFactory, RunReport, cohort_run
from .scoring import Scorecard, score

from saboteur.agents.factory import build_agent
from saboteur.agents.oracle import BuiltinReferenceOracle, Oracle

_DEFAULT_RUNS_DIR = Path("runs")
_DEFAULT_CONTROL_PROFILE = Path("profiles/calm_seas.yaml")


def make_run_id(profile_name: str) -> str:
    """Generate a unique, sortable run identifier."""
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{profile_name}-{stamp}-{uuid.uuid4().hex[:6]}"


async def orchestrate(
    profile_path: str | Path,
    n_agents: int | None = None,
    *,
    run_id: str | None = None,
    seed_override: int | None = None,
    with_control: bool = True,
    runs_dir: Path = _DEFAULT_RUNS_DIR,
    control_report: RunReport | None = None,
    control_profile_path: str | Path = _DEFAULT_CONTROL_PROFILE,
    concurrency_limit: int | None = None,
    agent_factory: AgentFactory = build_agent,
    oracle: Oracle | None = None,
) -> Scorecard:
    """Run control + chaos cohorts and return the persisted Scorecard.

    Must be awaited from a running event loop (binds each bus to it).

    The success ``oracle`` (default: the deterministic reference verifier) is
    judged once per agent at completion and frozen into telemetry; both cohorts
    use the same oracle so survival is comparable. It is bound onto the factory
    via ``functools.partial``, so the cohort/factory seam stays unchanged.
    """
    settings = get_settings()
    profile = load_profile(profile_path)
    if seed_override is not None:
        profile = profile.model_copy(update={"seed": seed_override})
    n = n_agents if n_agents is not None else settings.n_agents

    if run_id is None:
        run_id = make_run_id(profile.name)

    bound_factory: AgentFactory = functools.partial(
        agent_factory, oracle=oracle or BuiltinReferenceOracle()
    )

    if not with_control:
        control_report = RunReport(
            run_id=f"{run_id}-control",
            profile_name="calm_seas",
            seed=0,
            n_agents=n,
        )

    if control_report is None:
        control_profile = load_profile(control_profile_path)
        control_report = await _execute_cohort(
            f"{run_id}-control",
            n,
            control_profile,
            runs_dir,
            concurrency_limit=concurrency_limit,
            agent_factory=bound_factory,
        )

    report = await _execute_cohort(
        run_id,
        n,
        profile,
        runs_dir,
        concurrency_limit=concurrency_limit,
        agent_factory=bound_factory,
    )

    scorecard = score(
        report.events,
        control_report.events,
        run_id=run_id,
        profile=profile.name,
        control_run_id=control_report.run_id,
    )
    runs_dir.mkdir(parents=True, exist_ok=True)
    scorecard_path = runs_dir / f"{run_id}.scorecard.json"
    scorecard_path.write_text(
        scorecard.model_dump_json(indent=2), encoding="utf-8"
    )
    return scorecard


async def _execute_cohort(
    run_id: str,
    n_agents: int,
    profile: ChaosProfile,
    runs_dir: Path,
    *,
    concurrency_limit: int | None,
    agent_factory: AgentFactory,
) -> RunReport:
    """One cohort: fresh bus + JSONL writer + WS registration, then the cohort run.

    The bus is always closed, the writer always awaited, and the registry
    entry always removed — a failed cohort never leaks a registered bus.
    """
    bus = TelemetryBus()
    bus.bind(asyncio.get_running_loop())
    registry.register(run_id, bus)
    writer = JsonlWriter(bus, run_id, runs_dir=runs_dir)
    writer_task = asyncio.create_task(writer.run())
    try:
        return await cohort_run(
            run_id,
            n_agents,
            profile,
            bus,
            concurrency_limit=concurrency_limit,
            agent_factory=agent_factory,
        )
    finally:
        bus.close()
        try:
            await asyncio.wait_for(writer_task, timeout=10.0)
        except asyncio.TimeoutError:
            writer_task.cancel()
        registry.unregister(run_id)
