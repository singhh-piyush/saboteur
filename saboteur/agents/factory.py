# agent factory: assemble a sabotaged, instrumented SaboteurAgent

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable

from smolagents import ToolCallingAgent
from smolagents.memory import ActionStep

from saboteur.chaos.engine import ChaosEngine
from saboteur.chaos.events import FaultEvent
from saboteur.chaos.profile import ChaosProfile
from saboteur.config import get_model, get_settings

from .oracle import BuiltinReferenceOracle, Oracle, OracleRunContext, OracleVerdict
from .outcomes import (
    AgentEvent,
    AgentRunResult,
    StepRecord,
    classify_outcome,
    classify_recoveries,
)
from .task import TASK_PROMPT
from .tools import ReportStore, build_tools
from .verifier import verify

OnEvent = Callable[[AgentEvent], None]


# resilience guidance must not name the faults to avoid teaching to the test
RESILIENCE_INSTRUCTIONS = (
    "You are operating in an unreliable environment. Tools may occasionally "
    "fail, hang, or return surprising results. Work resiliently:\n"
    "- If a tool call errors, you may retry it up to 3 times before trying "
    "something else.\n"
    "- If an error mentions a rate limit or 'Retry-After', wait the indicated "
    "time before retrying that tool.\n"
    "- If one tool keeps failing, fall back to a different tool that can get "
    "you the same information.\n"
    "- Sanity-check tool outputs against what you expect; if a value looks "
    "implausible, gather corroborating evidence before trusting it.\n"
    "- Do not give up early: keep going until you have completed every step "
    "of the task.\n"
    "- Always respond with a tool call at every step — never output plain "
    "text on its own. Once file_report has succeeded, call final_answer to "
    "complete the task."
)


class SaboteurAgent:
    # one agent under chaos. created before the underlying agent so callbacks can be registered

    def __init__(
        self,
        agent_id: int,
        store: ReportStore,
        on_event: OnEvent | None = None,
        oracle: Oracle | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.store = store
        self._on_event = on_event
        # success oracle consulted once at completion. defaults to reference verifier for backward compatibility
        self._oracle: Oracle = oracle or BuiltinReferenceOracle()
        self.agent: ToolCallingAgent | None = None
        self.engine: ChaosEngine | None = None


        self._history: list[StepRecord] = []
        self._faults: list[FaultEvent] = []
        # Faults emitted during the in-flight step, drained by _on_step.
        self._pending_faults: list[FaultEvent] = []
        # silences callbacks post-finish to prevent orphan thread telemetry from breaking replay parity
        self._finished = False

    # telemetry errors must not propagate to the agent

    def _emit(self, kind: str, step: int | None, data: dict[str, Any]) -> None:
        if self._on_event is None or self._finished:
            return
        try:
            self._on_event(AgentEvent(self.agent_id, step, kind, data))
        except Exception:
            pass



    def _handle_fault(self, event: FaultEvent) -> None:
        # record and emit fault event
        # ignore faults from orphan thread to prevent post-run telemetry desync
        if self._finished:
            return
        step = getattr(self.agent, "step_number", None)
        self._faults.append(event)
        self._pending_faults.append(event)
        self._emit(
            "fault",
            step,
            {
                "fault": str(event.fault),
                "tool": event.tool_name,
                "call_index": event.call_index,
                "detail": event.detail,
            },
        )



    def _on_step(self, memory_step: ActionStep, agent: Any = None) -> None:
        # fires after each step. emits start, tool, and recovery events, and runs context_drop last
        if self._finished:
            return
        try:
            target = agent if agent is not None else self.agent
            record = self._build_record(memory_step)
            self._history.append(record)

            # smolagents has no pre-step hook, so step_start is emitted here
            # record tool parse failures in telemetry for diagnosis
            # fold raw output into step_start if action_step has AgentParsingError
            step_err = getattr(memory_step, "error", None)
            parse_failed = (
                step_err is not None
                and type(step_err).__name__ == "AgentParsingError"
            )
            step_payload: dict[str, Any] = (
                {
                    "parse_error": True,
                    "model_output": getattr(memory_step, "model_output", None),
                    "error": repr(step_err),
                }
                if parse_failed
                else {}
            )
            self._emit("step_start", record.step, step_payload)

            # emit tool call details for each tool call in the step
            tool_calls = getattr(memory_step, "tool_calls", None) or []
            for call in tool_calls:
                faulted_here = record.faulted and call.name == record.tool_name
                self._emit(
                    "tool_call",
                    record.step,
                    {
                        "tool": call.name,
                        "arguments": call.arguments,
                        "sabotaged": faulted_here,
                        "fault_types": list(record.fault_types),
                        "errored": record.errored,
                        "observation": record.observation,
                    },
                )

            # identify recovery for this step; terminal=False avoids speculative give-up
            recoveries = classify_recoveries(self._history, terminal=False)
            if recoveries and recoveries[-1].step == record.step:
                rec = recoveries[-1]
                self._emit(
                    "recovery",
                    record.step,
                    {"kind": str(rec.kind), "after_fault": rec.after_fault},
                )

            # run context_drop last so trimming does not affect this step's history
            if self.engine is not None and target is not None:
                self.engine.step_hook(target)
        except Exception:
            # prevent telemetry bugs from crashing the agent
            pass

    def _build_record(self, memory_step: ActionStep) -> StepRecord:
        # drain faults recorded during this step
        pending = self._pending_faults
        self._pending_faults = []
        fault_types = tuple(str(f.fault) for f in pending)

        tool_calls = getattr(memory_step, "tool_calls", None) or []
        first = tool_calls[0] if tool_calls else None
        error = getattr(memory_step, "error", None)
        return StepRecord(
            step=getattr(memory_step, "step_number", len(self._history) + 1),
            tool_name=first.name if first is not None else None,
            arguments=first.arguments if first is not None else None,
            faulted=bool(pending),
            fault_types=fault_types,
            errored=error is not None,
            observation=getattr(memory_step, "observations", None),
        )

    def _trace_records(self) -> list[dict[str, Any]]:
        # lightweight, JSON-able per-step trace for assertion/HTTP oracles
        return [
            {
                "step": rec.step,
                "tool": rec.tool_name,
                "faulted": rec.faulted,
                "fault_types": list(rec.fault_types),
                "errored": rec.errored,
            }
            for rec in self._history
        ]



    async def run(self) -> AgentRunResult:
        """Run the agent under a wall-clock timeout and classify the outcome.

        Runs the sync smolagents loop in a worker thread. A timeout leaves the
        worker thread as an orphan, which eventually exits due to step bounds.
        """
        assert self.agent is not None, "build_agent must set self.agent"
        settings = get_settings()

        raised = False
        timed_out = False
        error: str | None = None
        run_result = None

        t0 = time.perf_counter()
        try:
            run_result = await asyncio.wait_for(
                asyncio.to_thread(
                    self.agent.run, TASK_PROMPT, return_full_result=True
                ),
                timeout=settings.agent_timeout_s,
            )
        except asyncio.TimeoutError:
            timed_out = True
        except asyncio.CancelledError:
            # emit terminal before cancel propagates to prevent grid lock and ensure scoring
            # synchronous only: no awaits during cancellation; freeze failure instead of judging
            duration_ms = (time.perf_counter() - t0) * 1000.0
            outcome = classify_outcome(
                self._history,
                filed_report=bool(self.store.get(self.agent_id)),
                hit_step_cap=False,
                raised=False,
                timed_out=True,
            )
            self._emit(
                "terminal",
                None,
                {
                    "outcome": str(outcome),
                    "success": False,
                    "cancelled": True,
                    "tokens_used": 0,
                    "steps_taken": len(self._history),
                    "oracle": self._oracle.name,
                    "deception_aware": self._oracle.deception_aware,
                    "oracle_detail": "cancelled before completion - not judged",
                    "final_output": None,
                    "duration_ms": duration_ms,
                },
            )
            self._finished = True
            raise
        except Exception as exc:  # unexpected crash
            raised = True
            error = repr(exc)
        duration_ms = (time.perf_counter() - t0) * 1000.0

        task_result = verify(self.store, self.agent_id)
        filed_report = bool(self.store.get(self.agent_id))
        hit_step_cap = (
            run_result is not None
            and getattr(run_result, "state", None) == "max_steps_error"
        )
        tokens = _tokens_from(run_result)

        outcome = classify_outcome(
            self._history,
            filed_report=filed_report,
            hit_step_cap=hit_step_cap,
            raised=raised,
            timed_out=timed_out,
        )
        recoveries = classify_recoveries(self._history)

        # judge success exactly once at completion so scoring reads a frozen verdict
        # run in executor because assertion/HTTP oracles block
        raw_output = getattr(run_result, "output", None)
        final_output = str(raw_output) if raw_output is not None else None
        ctx = OracleRunContext(
            agent_id=self.agent_id,
            final_output=final_output,
            outcome=str(outcome),
            faults=[str(f.fault) for f in self._faults],
            tokens_used=tokens,
            steps_taken=len(self._history),
            reference_success=task_result.success,
            trace=self._trace_records(),
        )
        if timed_out:
            # freeze failure on timeout; oracle might falsely pass if orphan files late report
            verdict = OracleVerdict(
                success=False,
                detail=(
                    f"wall-clock timeout after {settings.agent_timeout_s}s "
                    "— not judged"
                ),
            )
        else:
            verdict = await asyncio.to_thread(self._oracle.judge, ctx)

        self._emit(
            "terminal",
            None,
            {
                "outcome": str(outcome),
                "success": verdict.success,
                "tokens_used": tokens,
                "steps_taken": len(self._history),
                "oracle": self._oracle.name,
                "deception_aware": self._oracle.deception_aware,
                "oracle_detail": verdict.detail,
                "final_output": final_output,
                "duration_ms": duration_ms,
            },
        )
        # terminal event emitted; orphan worker thread is now silenced to prevent post-run desync
        self._finished = True

        return AgentRunResult(
            agent_id=self.agent_id,
            outcome=outcome,
            task_result=task_result,
            tokens_used=tokens,
            steps_taken=len(self._history),
            recoveries=recoveries,
            faults=list(self._faults),
            error=error,
        )


def _tokens_from(run_result: Any) -> int:
    # sum input+output tokens from a smolagents RunResult, if available
    if run_result is None:
        return 0
    usage = getattr(run_result, "token_usage", None)
    if usage is None:
        return 0
    return int(getattr(usage, "input_tokens", 0)) + int(
        getattr(usage, "output_tokens", 0)
    )


def build_agent(
    agent_id: int,
    profile: ChaosProfile,
    store: ReportStore,
    on_event: OnEvent | None = None,
    *,
    oracle: Oracle | None = None,
) -> SaboteurAgent:
    """Assemble a sabotaged, instrumented agent for ``agent_id``.

    Args:
        agent_id: Unique per-agent id; seeds the engine RNG and keys the store.
        profile: A :class:`saboteur.chaos.ChaosProfile`.
        store: Shared report store; this agent writes only ``store[agent_id]``.
        on_event: Optional sink for :class:`AgentEvent`s (telemetry seam).
        oracle: Success oracle judged once at completion; defaults to the
            deterministic :class:`~saboteur.agents.oracle.BuiltinReferenceOracle`.

    Returns:
        A :class:`SaboteurAgent` ready to ``await .run()``.
    """
    shell = SaboteurAgent(
        agent_id=agent_id, store=store, on_event=on_event, oracle=oracle
    )

    # build engine first; handler only fires during run when shell.agent is set
    engine = ChaosEngine(profile, agent_id, on_fault=shell._handle_fault)
    shell.engine = engine

    # sabotage tools in-place without touching json boundary
    tools = build_tools(agent_id, store)
    for tool in tools:
        engine.sabotage_tool(tool)

    agent = ToolCallingAgent(
        tools=tools,
        model=get_model(),
        max_steps=get_settings().max_steps,
        instructions=RESILIENCE_INSTRUCTIONS,
        # smolagents requires identifier name
        name=f"agent_{agent_id}",
        step_callbacks={ActionStep: shell._on_step},
    )
    shell.agent = agent
    return shell
