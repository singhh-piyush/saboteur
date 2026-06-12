"""Agent factory: assemble a sabotaged, instrumented ``ToolCallingAgent``.

``build_agent(agent_id, profile, store)`` returns a :class:`SaboteurAgent` —
a thin async wrapper around a smolagents ``ToolCallingAgent`` whose four WP3
tools have been wrapped in a per-agent :class:`ChaosEngine`. The wrapper:

- runs the (sync) agent loop under ``asyncio.to_thread`` with a per-agent
  wall-clock timeout (invariant #5),
- classifies the terminal outcome and recovery actions with the pure
  functions in :mod:`.outcomes`,
- consults the programmatic verifier (invariant #4, never an LLM judge),
- streams structured :class:`AgentEvent`s through an ``on_event`` seam that
  the future telemetry bus will adapt (invariant #3).

One :class:`ChaosEngine`, one set of fresh tools, and one private history per
agent — no shared mutable state, safe under ~50 concurrent agents (invariant
#2). The model always comes from :func:`saboteur.config.get_model` (the single
inference seam) — never instantiated here.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from smolagents import ToolCallingAgent
from smolagents.memory import ActionStep

from saboteur.chaos.engine import ChaosEngine
from saboteur.chaos.events import FaultEvent
from saboteur.chaos.profile import ChaosProfile
from saboteur.config import get_model, get_settings

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


# Modest, generic resilience guidance injected as the agent's system-prompt
# ``instructions``. It must NOT name the eight faults or say when they fire —
# we measure self-healing, we don't teach to the test (CLAUDE.md).
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
    "of the task."
)


class SaboteurAgent:
    """One agent under chaos: assembly + instrumented async run.

    Construct via :func:`build_agent`. The instance is created *before* the
    underlying smolagents agent so that :meth:`_handle_fault` can serve as the
    engine's ``on_fault`` callback during construction; ``self.agent`` is then
    assigned and is always set by the time :meth:`run` (hence the callbacks)
    execute.
    """

    def __init__(
        self,
        agent_id: int,
        store: ReportStore,
        on_event: OnEvent | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.store = store
        self._on_event = on_event
        self.agent: ToolCallingAgent | None = None
        self.engine: ChaosEngine | None = None

        # Append-only analysis state, private to this agent (invariant #2).
        self._history: list[StepRecord] = []
        self._faults: list[FaultEvent] = []
        # Faults emitted during the in-flight step, drained by _on_step.
        self._pending_faults: list[FaultEvent] = []
        # Set in run()'s finally. Once true, all callbacks go silent: a
        # timed-out run leaves an orphan smolagents worker thread alive (see
        # run()'s note), and that thread must not keep emitting telemetry after
        # the harness has moved on — otherwise late events reach the JSONL but
        # not the in-memory collector, breaking replay parity (invariant #3).
        self._finished = False

    # ------------------------------------------------------------------
    # Event emission (telemetry must never crash an agent — invariant #3)
    # ------------------------------------------------------------------

    def _emit(self, kind: str, step: int | None, data: dict[str, Any]) -> None:
        if self._on_event is None or self._finished:
            return
        try:
            self._on_event(AgentEvent(self.agent_id, step, kind, data))
        except Exception:
            pass

    # ------------------------------------------------------------------
    # ChaosEngine callback
    # ------------------------------------------------------------------

    def _handle_fault(self, event: FaultEvent) -> None:
        """Engine ``on_fault`` sink: record + stamp with the current step."""
        # An orphan thread from a timed-out run may still hit a sabotaged tool;
        # drop its faults so post-run telemetry can't desync JSONL vs. collector.
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

    # ------------------------------------------------------------------
    # smolagents step callback (end of each ActionStep)
    # ------------------------------------------------------------------

    def _on_step(self, memory_step: ActionStep, agent: Any = None) -> None:
        """Fires after each step is finalized, before it is appended to memory.

        smolagents exposes no pre-step hook, so ``step_start`` is emitted here
        for the step that just completed. We build the :class:`StepRecord`,
        emit per-tool-call and recovery events, then run the context_drop hook
        *last* so our own history is unaffected by memory trimming.
        """
        if self._finished:
            return
        try:
            target = agent if agent is not None else self.agent
            record = self._build_record(memory_step)
            self._history.append(record)

            self._emit("step_start", record.step, {})

            # One tool_call event per call this step. (ToolCallingAgent files
            # one tool call per step in the common case, but be general.)
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

            # Recovery for the most recent transition, if any. terminal=False:
            # don't speculatively emit a give-up before the agent's next turn.
            recoveries = classify_recoveries(self._history, terminal=False)
            if recoveries and recoveries[-1].step == record.step:
                rec = recoveries[-1]
                self._emit(
                    "recovery",
                    record.step,
                    {"kind": str(rec.kind), "after_fault": rec.after_fault},
                )

            # Apply context_drop between turns. Done last: _history already
            # captured this step, so trimming agent memory never loses data
            # from our analysis (and never drops the live step we just saw).
            if self.engine is not None and target is not None:
                self.engine.step_hook(target)
        except Exception:
            # A telemetry/bookkeeping bug must never crash the agent loop.
            pass

    def _build_record(self, memory_step: ActionStep) -> StepRecord:
        # Drain faults stamped to this step by the engine callback.
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

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    async def run(self) -> AgentRunResult:
        """Run the agent under a wall-clock timeout and classify the outcome.

        The smolagents loop is synchronous, so it runs in a worker thread via
        ``asyncio.to_thread`` and is bounded by ``asyncio.wait_for``. Note:
        ``wait_for`` cannot truly cancel the worker thread — on timeout the
        orphan thread finishes on its own. That is acceptable because the run
        is also bounded by ``max_steps`` and per-tool fault sleeps (invariant
        #5); the wall-clock cap is a backstop, not the primary bound.
        """
        assert self.agent is not None, "build_agent must set self.agent"
        settings = get_settings()

        raised = False
        timed_out = False
        error: str | None = None
        run_result = None

        try:
            run_result = await asyncio.wait_for(
                asyncio.to_thread(
                    self.agent.run, TASK_PROMPT, return_full_result=True
                ),
                timeout=settings.agent_timeout_s,
            )
        except asyncio.TimeoutError:
            timed_out = True
        except Exception as exc:  # a non-AgentError escaped → real crash
            raised = True
            error = repr(exc)

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

        self._emit(
            "terminal",
            None,
            {
                "outcome": str(outcome),
                "success": task_result.success,
                "tokens_used": tokens,
                "steps_taken": len(self._history),
            },
        )
        # Terminal event is out; from here any orphan worker thread (from a
        # timed-out run) is silenced, so no telemetry can land after the
        # harness emits run_finished and desync JSONL vs. the collector.
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
    """Sum input+output tokens from a smolagents RunResult, if available."""
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
) -> SaboteurAgent:
    """Assemble a sabotaged, instrumented agent for ``agent_id``.

    Args:
        agent_id: Unique per-agent id; seeds the engine RNG and keys the store.
        profile: A :class:`saboteur.chaos.ChaosProfile`.
        store: Shared report store; this agent writes only ``store[agent_id]``.
        on_event: Optional sink for :class:`AgentEvent`s (telemetry seam).

    Returns:
        A :class:`SaboteurAgent` ready to ``await .run()``.
    """
    shell = SaboteurAgent(agent_id=agent_id, store=store, on_event=on_event)

    # Engine first: its on_fault is the shell's handler. The handler only runs
    # during run(), by which point shell.agent is set.
    engine = ChaosEngine(profile, agent_id, on_fault=shell._handle_fault)
    shell.engine = engine

    # Fresh tools per agent, sabotaged in place (JSON tool-call boundary
    # untouched — only forward() is wrapped).
    tools = build_tools(agent_id, store)
    for tool in tools:
        engine.sabotage_tool(tool)

    agent = ToolCallingAgent(
        tools=tools,
        model=get_model(),
        max_steps=get_settings().max_steps,
        instructions=RESILIENCE_INSTRUCTIONS,
        # smolagents requires name to be a valid Python identifier.
        name=f"agent_{agent_id}",
        step_callbacks={ActionStep: shell._on_step},
    )
    shell.agent = agent
    return shell
