"""BYO cohort spawner — launch N subprocess agents through the wire proxy.

The subprocess analogue of :func:`saboteur.harness.cohort.cohort_run`: same
shape (a concurrency semaphore + ``gather(return_exceptions=True)`` + a hard
per-agent wall-clock timeout), but the agent source is an **OS subprocess** and
telemetry arrives **through the proxy**, not via an in-process ``on_event``.

Each subprocess is a copy of a BYO ``command`` target, pointed at the proxy
(``OPENAI_BASE_URL=<proxy>/v1``) and attributed to one proxy session via the
``SABOTEUR_RUN_ID`` / ``SABOTEUR_AGENT_ID`` env vars (the agent forwards them as
``X-Saboteur-*`` headers — see :mod:`saboteur.proxy.shim` and the bundled
``examples/byo_min_agent``). As the agent makes chat-completions calls, the proxy
injects faults and emits the same ``TelemetryEvent`` schema as the reference
cohort, so the existing grid / scorecard / replay render live with no change.

Invariants: each agent is its own OS process (crash isolation, #2); a timed-out
process is SIGKILL'd by **process group** (bounded runs, #5); no shared mutable
state across agents (each owns its env + subprocess + proxy session).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path

from saboteur.agents.oracle import Oracle, OracleRunContext
from saboteur.chaos.profile import ChaosProfile
from saboteur.config import get_settings
from saboteur.proxy.session import AgentTerminal, ProxyRun, manager

from .targets import Target, build_oracle

_DEFAULT_RUNS_DIR = Path("runs")


async def run_byo_cohort(
    run_id: str,
    target: Target,
    profile: ChaosProfile,
    n_agents: int,
    *,
    runs_dir: Path = _DEFAULT_RUNS_DIR,
    concurrency_limit: int | None = None,
    agent_timeout_s: float | None = None,
    proxy_base: str | None = None,
) -> None:
    """Run a BYO command target as an ``n_agents`` cohort under *profile*.

    Sets up (or reuses) the proxy run, spawns the subprocesses concurrently,
    waits for them with a per-agent wall-clock kill, judges the target's oracle
    (if any) once per agent at completion, and finishes the run (emits terminals
    + ``run_finished``, scores behavioral tier, persists the scorecard, tears
    down). ``finish`` runs in a ``finally`` so the run is always scored — even
    if every spawn failed.
    """
    if target.kind != "command" or not target.cmd:
        raise ValueError("run_byo_cohort requires a 'command' target with a cmd")

    settings = get_settings()
    limit = (
        settings.concurrency_limit if concurrency_limit is None else concurrency_limit
    )
    timeout_s = (
        float(settings.agent_timeout_s) if agent_timeout_s is None else agent_timeout_s
    )
    base = proxy_base if proxy_base is not None else settings.proxy_public_base_url
    semaphore = asyncio.Semaphore(limit) if limit > 0 else None

    run = await manager.create(run_id, profile, n_agents, runs_dir=runs_dir)
    # The spawner owns this run's lifecycle (it always calls finish() in its
    # finally, with per-agent terminals). Neutralise the idle watchdog so it
    # can't auto-finish mid-cohort with terminals=None and drop our outcome
    # classification — the watchdog exists only for the header-only proxy path.
    run.idle_timeout_s = float("inf")
    oracle = build_oracle(target.oracle)

    async def _guarded(agent_id: int) -> AgentTerminal:
        try:
            if semaphore is None:
                return await _spawn_one(run, target, run_id, agent_id, oracle, base, timeout_s)
            async with semaphore:
                return await _spawn_one(run, target, run_id, agent_id, oracle, base, timeout_s)
        except Exception as exc:  # never let one agent's failure escape (#2)
            return AgentTerminal(agent_id, raised=True, detail=repr(exc))

    terminals: dict[int, AgentTerminal] = {}
    try:
        raw = await asyncio.gather(
            *(_guarded(i) for i in range(n_agents)), return_exceptions=True
        )
        for i, result in enumerate(raw):
            terminals[i] = (
                result
                if isinstance(result, AgentTerminal)
                else AgentTerminal(i, raised=True, detail=repr(result))
            )
    finally:
        await run.finish(terminals=terminals)


async def _spawn_one(
    run: ProxyRun,
    target: Target,
    run_id: str,
    agent_id: int,
    oracle: Oracle | None,
    proxy_base: str,
    timeout_s: float,
) -> AgentTerminal:
    """Spawn one subprocess agent, await it (bounded), judge the oracle."""
    # An initial step_start makes the agent's card appear on the grid the moment
    # it's launched (Battle-Royale visual); step 0 never collides with the
    # proxy's real steps (which start at 1) and is ignored by scoring.
    run.emit_step_start(agent_id, 0)

    env = _build_env(target, run_id, agent_id, proxy_base)
    assert target.cmd is not None  # guaranteed by run_byo_cohort

    try:
        proc = await asyncio.create_subprocess_exec(
            *target.cmd,
            cwd=target.cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,  # own process group ⇒ killable as a unit
        )
    except Exception as exc:
        return await _judge(
            run, agent_id, oracle, AgentTerminal(agent_id, raised=True, detail=repr(exc))
        )

    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        _kill_group(proc)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        return await _judge(
            run,
            agent_id,
            oracle,
            AgentTerminal(agent_id, timed_out=True, detail="wall-clock timeout"),
        )

    rc = proc.returncode or 0
    terminal = AgentTerminal(
        agent_id,
        exit_code=rc,
        raised=rc != 0,
        final_output=out.decode("utf-8", errors="replace") if out else "",
        detail=(err.decode("utf-8", errors="replace")[:200] if err else None),
    )
    return await _judge(run, agent_id, oracle, terminal)


def _build_env(
    target: Target, run_id: str, agent_id: int, proxy_base: str
) -> dict[str, str]:
    """The subprocess environment: target extras + forced routing/attribution."""
    env = {**os.environ, **target.env}
    # We own routing + attribution — these always win over target.env.
    env["OPENAI_BASE_URL"] = f"{proxy_base.rstrip('/')}/v1"
    env["SABOTEUR_RUN_ID"] = run_id
    env["SABOTEUR_AGENT_ID"] = str(agent_id)
    env["MODEL_ID"] = get_settings().model_id
    env.setdefault("OPENAI_API_KEY", "none")  # the agent may set a real one via env
    return env


async def _judge(
    run: ProxyRun,
    agent_id: int,
    oracle: Oracle | None,
    terminal: AgentTerminal,
) -> AgentTerminal:
    """Freeze the oracle's verdict onto the terminal (once, at completion).

    No oracle → ``success`` stays ``None`` (behavioral tier only). A command /
    http oracle blocks on I/O, so it runs in a worker thread; its own impls
    never raise into us (invariant #4).
    """
    if oracle is None:
        return terminal
    sess = run.session(agent_id)
    faults = sorted({ft for rec in sess.history for ft in rec.fault_types})
    trace = [
        {
            "step": rec.step,
            "tool_name": rec.tool_name,
            "arguments": rec.arguments,
            "faulted": rec.faulted,
            "fault_types": list(rec.fault_types),
            "errored": rec.errored,
        }
        for rec in sess.history
    ]
    outcome = "timeout" if terminal.timed_out else (
        "hard_exception" if terminal.raised else "completed"
    )
    ctx = OracleRunContext(
        agent_id=agent_id,
        final_output=terminal.final_output or "",
        outcome=outcome,
        faults=faults,
        tokens_used=terminal.tokens_used if terminal.tokens_used is not None else sess.tokens,
        steps_taken=len(sess.history),
        trace=trace,
    )
    verdict = await asyncio.to_thread(oracle.judge, ctx)
    terminal.success = verdict.success
    terminal.oracle = oracle.name
    terminal.deception_aware = oracle.deception_aware
    terminal.oracle_detail = verdict.detail
    return terminal


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    """SIGKILL the subprocess's whole process group (POSIX), best-effort.

    ``start_new_session=True`` made the child a group leader, so this reaps any
    helpers it spawned too. Falls back to killing just the child, and tolerates
    an already-dead process.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError, AttributeError):
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.kill()
