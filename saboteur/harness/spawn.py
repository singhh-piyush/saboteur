"""BYO cohort spawner.

Launches N subprocess agents through the wire proxy.
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
    # run a BYO command target as an n_agents cohort under profile
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
    # disable idle watchdog since spawner manages lifecycle
    run.idle_timeout_s = float("inf")
    oracle = build_oracle(target.oracle)

    async def _guarded(agent_id: int) -> AgentTerminal:
        try:
            if semaphore is None:
                return await _spawn_one(run, target, run_id, agent_id, oracle, base, timeout_s)
            async with semaphore:
                return await _spawn_one(run, target, run_id, agent_id, oracle, base, timeout_s)
        except Exception as exc:  # prevent single agent failure from escaping
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
    # spawn one subprocess agent, await it (bounded), judge the oracle
    # emit step 0 start so agent is visible on the grid immediately
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
            start_new_session=True,  # spawn in a new process group
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
    # the subprocess environment: target extras + forced routing/attribution
    env = {**os.environ, **target.env}
    # routing and attribution override target environment variables
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
    # freeze the oracle's verdict onto the terminal at completion
    if oracle is None:
        return terminal
    if terminal.timed_out:
        # freeze failure on timeout; process did not complete task
        terminal.success = False
        terminal.oracle = oracle.name
        terminal.deception_aware = oracle.deception_aware
        terminal.oracle_detail = "wall-clock timeout — not judged"
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
    # only exit-state outcomes reach here
    outcome = "hard_exception" if terminal.raised else "completed"
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
    # SIGKILL the subprocess's process group
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError, AttributeError):
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.kill()
