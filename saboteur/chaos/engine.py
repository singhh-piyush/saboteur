# chaos engine wires a chaos profile onto an agent's tools

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

from .events import FaultEvent, FaultType, ToolVanishedError
from .interceptors import (
    Detail,
    ToolVanishInterceptor,
    build_interceptors,
)
from .profile import ChaosProfile
from .rng import seeded_rng

if TYPE_CHECKING:
    from smolagents import Tool

OnFault = Callable[[FaultEvent], None]


class ChaosEngine:
    # deterministic fault injection for one agent

    def __init__(
        self,
        profile: ChaosProfile,
        agent_id: int,
        on_fault: OnFault | None = None,
    ) -> None:
        self.profile = profile
        self.agent_id = agent_id
        self._on_fault = on_fault
        self._rng = seeded_rng(profile.seed, agent_id)
        self._call_index = 0
        self._tool_interceptors, self._context_interceptors = build_interceptors(
            profile, self._rng
        )



    def wrap(self, name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
        # wrap a plain callable in this engine's interceptor chain

        def sabotaged(*args: Any, **kwargs: Any) -> Any:
            return self._invoke(name, fn, *args, **kwargs)

        sabotaged.__name__ = f"sabotaged_{name}"
        return sabotaged

    def wrap_tools(
        self, tools: dict[str, Callable[..., Any]]
    ) -> dict[str, Callable[..., Any]]:
        # wrap a registry of callables, keyed by tool name
        return {name: self.wrap(name, fn) for name, fn in tools.items()}

    def sabotage_tool(self, tool: "Tool") -> "Tool":
        # sabotage a smolagents tool in place by wrapping its forward method
        tool.forward = self.wrap(tool.name, tool.forward)  # type: ignore[method-assign]
        return tool

    def step_hook(self, agent: Any) -> None:
        # run context-layer faults; call between agent steps
        for interceptor in self._context_interceptors:
            interceptor.maybe_drop(
                agent,
                lambda fault, detail: self._emit(
                    fault, None, self._call_index, detail
                ),
            )



    def _invoke(
        self, name: str, fn: Callable[..., Any], *args: Any, **kwargs: Any
    ) -> Any:
        index = self._call_index
        self._call_index += 1

        def emit(fault: FaultType, detail: Detail) -> None:
            self._emit(fault, name, index, detail)

        # vanished tools stay vanished, short-circuit before draws
        for interceptor in self._tool_interceptors:
            if isinstance(interceptor, ToolVanishInterceptor) and interceptor.is_vanished(name):
                emit(FaultType.TOOL_VANISH, {"sticky": True})
                raise ToolVanishedError(name)

        # draw decisions in profile order before acting to keep RNG sequence fixed
        decisions = [
            (interceptor, interceptor.decide(name))
            for interceptor in self._tool_interceptors
            if interceptor.applies_to(name)
        ]

        for interceptor, fired in decisions:
            if fired and interceptor.kind == "latency":
                interceptor.apply(name, emit)  # type: ignore[attr-defined]

        for interceptor, fired in decisions:
            if fired and interceptor.kind == "raising":
                interceptor.inject(name, emit)  # type: ignore[attr-defined]

        result = fn(*args, **kwargs)

        for interceptor, fired in decisions:
            if fired and interceptor.kind == "corrupting":
                return interceptor.corrupt(result, emit)  # type: ignore[attr-defined]
        return result

    def _emit(
        self,
        fault: FaultType,
        tool_name: str | None,
        call_index: int,
        detail: Detail,
    ) -> None:
        if self._on_fault is None:
            return
        event = FaultEvent(
            fault=fault,
            tool_name=tool_name,
            call_index=call_index,
            agent_id=self.agent_id,
            detail=detail,
        )
        try:
            self._on_fault(event)
        except Exception:
            # prevent telemetry errors from crashing agent
            pass
