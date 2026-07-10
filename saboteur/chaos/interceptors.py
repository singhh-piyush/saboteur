"""Fault interceptors composable at three layers.

Implements the 8 fault interceptors for tool, transport, and context layers.
"""

from __future__ import annotations

import functools
import json
import re
import time
from collections import deque
from typing import Any, Callable, NoReturn

from .events import (
    FaultType,
    SimulatedAPIError,
    SimulatedRateLimit,
    SimulatedTimeout,
    ToolVanishedError,
)
from .profile import ChaosProfile, FaultSpec
from .rng import ChaosRandom

Detail = dict[str, Any]
EmitFn = Callable[[FaultType, Detail], None]

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


class Interceptor:
    # base for tool- and transport-layer interceptors

    kind: str  # "latency" | "raising" | "corrupting"
    fault: FaultType

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        self.spec = spec
        self.rng = rng

    def applies_to(self, tool_name: str) -> bool:
        return self.spec.target_tools is None or tool_name in self.spec.target_tools

    def decide(self, tool_name: str) -> bool:
        # draw this call's fire decision (exactly one RNG draw)
        return self.rng.should_fire(self.spec.probability)


class ApiErrorInterceptor(Interceptor):
    kind = "raising"
    fault = FaultType.API_ERROR

    def draw_status(self, emit: EmitFn) -> int:
        # draw the status, emit the fault, and return it
        status = self.rng.choice(self.spec.status_codes)
        emit(self.fault, {"status_code": status})
        return status

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        raise SimulatedAPIError(self.draw_status(emit))


class RateLimitInterceptor(Interceptor):
    # rate limit interceptor using call-count budget

    kind = "raising"
    fault = FaultType.RATE_LIMIT

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        super().__init__(spec, rng)
        self._windows: dict[str, deque[bool]] = {}

    def decide(self, tool_name: str) -> bool:
        fired = self.rng.should_fire(self.spec.probability)
        if self.spec.burst_budget is None:
            return fired
        window = self._windows.setdefault(
            tool_name, deque(maxlen=self.spec.window_calls)
        )
        limited = fired or sum(window) >= self.spec.burst_budget
        window.append(not limited)
        return limited

    def draw_retry_after(self, emit: EmitFn) -> float:
        # draw the Retry-After hint, emit the fault, and return it (no raise)
        # Profile validation guarantees retry_after_s is set for rate_limit.
        assert self.spec.retry_after_s is not None
        retry_after = round(self.rng.uniform(*self.spec.retry_after_s), 1)
        emit(self.fault, {"retry_after_s": retry_after})
        return retry_after

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        raise SimulatedRateLimit(self.draw_retry_after(emit))


class ToolVanishInterceptor(Interceptor):
    # once triggered, the tool is gone for the remainder of the run

    kind = "raising"
    fault = FaultType.TOOL_VANISH

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        super().__init__(spec, rng)
        self._vanished: set[str] = set()

    def is_vanished(self, tool_name: str) -> bool:
        return tool_name in self._vanished

    def vanish(self, tool_name: str, emit: EmitFn) -> None:
        # mark a tool vanished for this session
        self._vanished.add(tool_name)
        emit(self.fault, {"sticky": False})

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        self.vanish(tool_name, emit)
        raise ToolVanishedError(tool_name)


class TimeoutInterceptor(Interceptor):
    kind = "raising"
    fault = FaultType.TIMEOUT

    def draw_deadline(self, emit: EmitFn) -> float:
        # emit the fault and return the deadline
        # Profile validation guarantees timeout_after_s is set for timeout.
        deadline = self.spec.timeout_after_s
        assert deadline is not None
        emit(self.fault, {"timeout_after_s": deadline})
        return deadline

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        deadline = self.draw_deadline(emit)
        time.sleep(deadline)
        raise SimulatedTimeout(deadline)


class LatencyInterceptor(Interceptor):
    kind = "latency"
    fault = FaultType.LATENCY

    def draw_delay(self, emit: EmitFn) -> float:
        # draw delay, emit fault, and return it
        # Profile validation guarantees delay_s is set for latency.
        assert self.spec.delay_s is not None
        delay = round(self.rng.uniform(*self.spec.delay_s), 3)
        emit(self.fault, {"delay_s": delay})
        return delay

    def apply(self, tool_name: str, emit: EmitFn) -> None:
        time.sleep(self.draw_delay(emit))


class MalformedInterceptor(Interceptor):
    # truncates the tool's output into broken JSON / garbage text

    kind = "corrupting"
    fault = FaultType.MALFORMED

    def corrupt(self, result: Any, emit: EmitFn) -> str:
        text = result if isinstance(result, str) else json.dumps(result, default=str)
        cut = max(1, int(len(text) * self.rng.uniform(0.25, 0.6)))
        emit(self.fault, {"original_len": len(text), "truncated_to": cut})
        return text[:cut]


class SilentLieInterceptor(Interceptor):
    # perturbs numeric values so the output is wrong but well-formed

    kind = "corrupting"
    fault = FaultType.SILENT_LIE

    def corrupt(self, result: Any, emit: EmitFn) -> Any:
        if isinstance(result, bool):
            lied: Any = not result
        elif isinstance(result, (int, float)):
            lied = self._lie_number(result, factor=True)
        elif isinstance(result, str):
            lied = self._lie_in_text(result)
        elif isinstance(result, (dict, list)):
            try:
                lied = json.loads(self._lie_in_text(json.dumps(result)))
            except (TypeError, ValueError):
                lied = result
        else:
            lied = result
        emit(
            self.fault,
            {"original": repr(result)[:200], "lied": repr(lied)[:200]},
        )
        return lied

    def _lie_number(self, value: float, *, factor: bool) -> int | float:
        if factor:
            lied = value * self.rng.uniform(*self.spec.lie_factor)
        else:
            sign = self.rng.choice((-1.0, 1.0))
            lied = value + sign * self.rng.uniform(*self.spec.lie_offset)
        return int(round(lied)) if isinstance(value, int) else round(lied, 1)

    def _lie_in_text(self, text: str) -> str:
        # silent_lie corrupts only the last number in a multi-unit temperature reading so the agent can detect the inconsistency
        matches = list(_NUMBER_RE.finditer(text))
        if not matches:
            return text
        m = matches[-1]
        token = m.group(0)
        value = float(token)
        is_int = "." not in token
        lied = self._lie_number(int(value) if is_int else value, factor=False)
        return text[: m.start()] + str(lied) + text[m.end() :]


class ContextDropInterceptor:
    # deletes the last K steps from an agent's memory

    fault = FaultType.CONTEXT_DROP

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        self.spec = spec
        self.rng = rng

    def maybe_drop(self, agent: Any, emit: EmitFn) -> None:
        if not self.rng.should_fire(self.spec.probability):
            return
        # Profile validation guarantees drop_last_k is set for context_drop.
        assert self.spec.drop_last_k is not None
        try:
            steps = getattr(getattr(agent, "memory", None), "steps", None)
            if not isinstance(steps, list) or not steps:
                return
            dropped = 0
            index = len(steps) - 1
            while index >= 0 and dropped < self.spec.drop_last_k:
                if not _is_task_step(steps[index]):
                    del steps[index]
                    dropped += 1
                index -= 1
            if dropped:
                emit(self.fault, {"dropped_steps": dropped})
        except Exception:
            return


@functools.cache
def _task_step_type() -> type | None:
    try:
        from smolagents.memory import TaskStep

        return TaskStep
    except Exception:
        return None


def _is_task_step(step: Any) -> bool:
    # name check first to be compatible with other versions
    if type(step).__name__ == "TaskStep":
        return True
    task_step = _task_step_type()
    return task_step is not None and isinstance(step, task_step)


INTERCEPTOR_TYPES: dict[FaultType, type[Interceptor]] = {
    FaultType.API_ERROR: ApiErrorInterceptor,
    FaultType.RATE_LIMIT: RateLimitInterceptor,
    FaultType.MALFORMED: MalformedInterceptor,
    FaultType.SILENT_LIE: SilentLieInterceptor,
    FaultType.TOOL_VANISH: ToolVanishInterceptor,
    FaultType.LATENCY: LatencyInterceptor,
    FaultType.TIMEOUT: TimeoutInterceptor,
}


def build_interceptors(
    profile: ChaosProfile, rng: ChaosRandom
) -> tuple[list[Interceptor], list[ContextDropInterceptor]]:
    # construct a profile's interceptors in profile order
    tool_interceptors: list[Interceptor] = []
    context_interceptors: list[ContextDropInterceptor] = []
    for spec in profile.faults:
        if spec.type is FaultType.CONTEXT_DROP:
            context_interceptors.append(ContextDropInterceptor(spec, rng))
        else:
            tool_interceptors.append(INTERCEPTOR_TYPES[spec.type](spec, rng))
    return tool_interceptors, context_interceptors
