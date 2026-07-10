
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from saboteur.agents.outcomes import StepRecord, classify_outcome
from saboteur.chaos.interceptors import (
    ContextDropInterceptor,
    Interceptor,
    ToolVanishInterceptor,
    build_interceptors,
)
from saboteur.chaos.profile import ChaosProfile
from saboteur.chaos.rng import seeded_rng
from saboteur.config import get_settings
from saboteur.harness.scoring import score
from saboteur.telemetry import build
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import JsonlWriter
from saboteur.telemetry.schema import EventKind, TelemetryEvent
from saboteur.telemetry.ws import registry as ws_registry

_DEFAULT_RUNS_DIR = Path("runs")
_WATCHDOG_INTERVAL_S = 5.0


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


@dataclass
class AgentTerminal:
    agent_id: int
    raised: bool = False
    timed_out: bool = False
    exit_code: int | None = None
    success: bool | None = None
    oracle: str | None = None
    deception_aware: bool = False
    oracle_detail: str | None = None
    final_output: str | None = None
    tokens_used: int | None = None
    detail: str | None = None


class ProxySession:

    def __init__(self, run_id: str, agent_id: int, profile: ChaosProfile) -> None:
        self.run_id = run_id
        self.agent_id = agent_id
        rng = seeded_rng(profile.seed, agent_id)
        self.tool_interceptors: list[Interceptor]
        self.context_interceptors: list[ContextDropInterceptor]
        self.tool_interceptors, self.context_interceptors = build_interceptors(
            profile, rng
        )
        self.vanish: ToolVanishInterceptor | None = next(
            (i for i in self.tool_interceptors if isinstance(i, ToolVanishInterceptor)),
            None,
        )
        self.step = 0
        self.history: list[StepRecord] = []
        self.tokens = 0
        self.lock = asyncio.Lock()

    def next_step(self) -> int:
        self.step += 1
        return self.step


class ProxyRun:

    def __init__(
        self,
        run_id: str,
        profile: ChaosProfile,
        n_agents: int,
        bus: TelemetryBus,
        writer_task: asyncio.Task[None],
        *,
        runs_dir: Path = _DEFAULT_RUNS_DIR,
        idle_timeout_s: float | None = None,
        capture_all: bool = False,
    ) -> None:
        self.run_id = run_id
        self.profile = profile
        self.n_agents = n_agents
        self._bus = bus
        self._writer_task = writer_task
        self._runs_dir = runs_dir
        self.idle_timeout_s = (
            idle_timeout_s
            if idle_timeout_s is not None
            else float(get_settings().proxy_idle_timeout_s)
        )
        self.capture_all = capture_all
        self._capture_next = 0
        self._capture_current: int | None = None
        self.sessions: dict[int, ProxySession] = {}
        self.events: list[TelemetryEvent] = []
        self.last_activity = time.monotonic()
        self._finished = False
        self._finish_lock = asyncio.Lock()
        self._watchdog: asyncio.Task[None] | None = None


    def session(self, agent_id: int) -> ProxySession:
        sess = self.sessions.get(agent_id)
        if sess is None:
            sess = ProxySession(self.run_id, agent_id, self.profile)
            self.sessions[agent_id] = sess
        return sess

    def capture_agent_id(self, parsed: dict[str, Any]) -> int:
        messages = parsed.get("messages") or []
        is_start = not any(
            isinstance(m, dict) and m.get("role") == "assistant" for m in messages
        )
        if is_start or self._capture_current is None:
            self._capture_current = min(self._capture_next, self.n_agents - 1)
            self._capture_next += 1
        return self._capture_current

    def touch(self) -> None:
        self.last_activity = time.monotonic()


    def emit(self, event: TelemetryEvent) -> None:
        try:
            self.events.append(event)
            self._bus.emit(event)
        except Exception:
            pass

    def _event(
        self,
        agent_id: int,
        step: int | None,
        kind: EventKind,
        *,
        fault: str | None = None,
        recovery: str | None = None,
        tokens_used: int | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.emit(
            TelemetryEvent(
                run_id=self.run_id,
                agent_id=agent_id,
                step=step,
                event=kind,
                fault=fault,
                recovery=recovery,
                tokens_used=tokens_used,
                payload=payload or {},
            )
        )

    def emit_run_started(self) -> None:
        self.emit(
            build.run_started_event(
                self.run_id, self.profile.name, self.profile.seed, self.n_agents
            )
        )

    def emit_step_start(self, agent_id: int, step: int) -> None:
        self.emit(build.step_start_event(self.run_id, agent_id, step))

    def emit_tool_call(
        self,
        agent_id: int,
        step: int,
        tool: str | None,
        arguments: Any,
        *,
        sabotaged: bool,
        fault_types: list[str],
        errored: bool,
    ) -> None:
        self.emit(
            build.tool_call_event(
                self.run_id,
                agent_id,
                step,
                tool,
                arguments,
                sabotaged=sabotaged,
                fault_types=fault_types,
                errored=errored,
            )
        )

    def emit_fault(
        self,
        agent_id: int,
        step: int,
        fault: str,
        *,
        tool: str | None,
        detail: dict[str, Any],
    ) -> None:
        self.emit(
            build.fault_event(
                self.run_id, agent_id, step, fault, tool=tool, detail=detail
            )
        )

    def emit_recovery(
        self, agent_id: int, step: int, kind: str, after_fault: str
    ) -> None:
        self.emit(
            build.recovery_event(self.run_id, agent_id, step, kind, after_fault)
        )


    def start_watchdog(self) -> None:
        self._watchdog = asyncio.create_task(self._idle_watch())

    async def _idle_watch(self) -> None:
        try:
            while not self._finished:
                await asyncio.sleep(_WATCHDOG_INTERVAL_S)
                if self._finished:
                    return
                idle = time.monotonic() - self.last_activity
                if self.sessions and idle >= self.idle_timeout_s:
                    await self.finish()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            return

    async def finish(
        self, *, terminals: dict[int, AgentTerminal] | None = None
    ) -> None:
        async with self._finish_lock:
            if self._finished:
                return
            self._finished = True

        if manager.capture_run is self:
            manager.clear_capture(self)

        if terminals is None:
            agent_ids = sorted(self.sessions.keys())
        else:
            agent_ids = sorted(
                set(range(self.n_agents)) | set(self.sessions) | set(terminals)
            )

        outcome_counts: dict[str, int] = {}
        for agent_id in agent_ids:
            sess = self.session(agent_id)
            term = (terminals or {}).get(agent_id)
            raised = term.raised if term else False
            timed_out = term.timed_out if term else False
            outcome = classify_outcome(
                sess.history,
                filed_report=not (raised or timed_out),
                hit_step_cap=False,
                raised=raised,
                timed_out=timed_out,
            )
            outcome_counts[str(outcome)] = outcome_counts.get(str(outcome), 0) + 1

            tokens = (
                term.tokens_used
                if term is not None and term.tokens_used is not None
                else sess.tokens
            )
            payload: dict[str, Any] = {
                "outcome": str(outcome),
                "success": term.success if term else None,
                "tokens_used": tokens,
                "steps_taken": len(sess.history),
                "oracle": term.oracle if term else None,
                "deception_aware": term.deception_aware if term else False,
            }
            if term is not None:
                payload.update(
                    oracle_detail=term.oracle_detail,
                    final_output=term.final_output,
                    exit_code=term.exit_code,
                    timed_out=term.timed_out,
                )
            self._event(
                agent_id, None, "agent_done", tokens_used=tokens, payload=payload
            )

        self.emit(build.run_finished_event(self.run_id, self.n_agents, outcome_counts))

        try:
            scorecard = score(
                self.events,
                [],
                run_id=self.run_id,
                profile=self.profile.name,
                control_run_id=None,
            )
            self._runs_dir.mkdir(parents=True, exist_ok=True)
            (self._runs_dir / f"{self.run_id}.scorecard.json").write_text(
                scorecard.model_dump_json(indent=2), encoding="utf-8"
            )
        except Exception:
            pass

        self._bus.close()
        try:
            await asyncio.wait_for(self._writer_task, timeout=10.0)
        except (asyncio.TimeoutError, Exception):
            self._writer_task.cancel()
        ws_registry.unregister(self.run_id)
        from saboteur.api.state import RunStatus, run_registry

        state = run_registry.get(self.run_id)
        if state is not None:
            state.status = RunStatus.FINISHED
            state.finished_at = _now()
        if self._watchdog is not None and not self._watchdog.done():
            self._watchdog.cancel()


class ProxyRunManager:

    def __init__(self) -> None:
        self._runs: dict[str, ProxyRun] = {}
        self._capture_run: ProxyRun | None = None

    def get(self, run_id: str) -> ProxyRun | None:
        return self._runs.get(run_id)

    @property
    def capture_run(self) -> ProxyRun | None:
        return self._capture_run

    def clear_capture(self, run: ProxyRun) -> None:
        if self._capture_run is run:
            self._capture_run = None

    async def create(
        self,
        run_id: str,
        profile: ChaosProfile,
        n_agents: int,
        *,
        runs_dir: Path = _DEFAULT_RUNS_DIR,
        capture_all: bool = False,
    ) -> ProxyRun:
        if capture_all and self._capture_run is not None:
            await self._capture_run.finish()
        bus = TelemetryBus()
        bus.bind(asyncio.get_running_loop())
        ws_registry.register(run_id, bus)
        writer = JsonlWriter(bus, run_id, runs_dir=runs_dir)
        writer_task = asyncio.create_task(writer.run())
        await asyncio.sleep(0)

        from saboteur.api.state import RunState, RunStatus, run_registry

        if run_registry.get(run_id) is None:
            run_registry.add(
                RunState(
                    run_id=run_id,
                    profile=profile.name,
                    n_agents=n_agents,
                    with_control=False,
                    status=RunStatus.RUNNING,
                    started_at=_now(),
                )
            )

        run = ProxyRun(
            run_id,
            profile,
            n_agents,
            bus,
            writer_task,
            runs_dir=runs_dir,
            capture_all=capture_all,
        )
        self._runs[run_id] = run
        if capture_all:
            self._capture_run = run
        run.emit_run_started()
        run.start_watchdog()
        return run


manager = ProxyRunManager()
