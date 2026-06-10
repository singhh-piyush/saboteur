"""The 8 fault interceptors, composable at three layers.

Each interceptor instance belongs to exactly one :class:`ChaosEngine`
(one engine per agent), so all sticky state (vanished tools, rate-limit
windows) is per-agent by construction — no shared mutable state
(invariant #2) and no locks needed (an agent's tool calls are
sequential).

Interceptor kinds, applied by the engine in this order per tool call:

- ``latency``    — sleep before the call (transport; composes with the rest)
- ``raising``    — raise instead of calling the tool; first fired wins
- ``corrupting`` — mutate the real tool's output; first fired wins

Sleeps are synchronous ``time.sleep``: smolagents tools are sync and
each agent loop runs under ``asyncio.to_thread``, so a blocking sleep
stalls only that agent's worker thread, never the event loop.

``context_drop`` is not a tool wrapper — it is a hook called between
agent steps that trims the tail of ``agent.memory.steps``.
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
from .profile import FaultSpec
from .rng import ChaosRandom

Detail = dict[str, Any]
EmitFn = Callable[[FaultType, Detail], None]

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


class Interceptor:
    """Base for tool- and transport-layer interceptors."""

    kind: str  # "latency" | "raising" | "corrupting"
    fault: FaultType

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        self.spec = spec
        self.rng = rng

    def applies_to(self, tool_name: str) -> bool:
        return self.spec.target_tools is None or tool_name in self.spec.target_tools

    def decide(self, tool_name: str) -> bool:
        """Draw this call's fire/no-fire decision (exactly one RNG draw).

        The engine calls this for every applicable interceptor on every
        call, in profile order, regardless of which fault ends up
        winning — a fixed draw order keeps the sequence deterministic.
        """
        return self.rng.should_fire(self.spec.probability)


class ApiErrorInterceptor(Interceptor):
    kind = "raising"
    fault = FaultType.API_ERROR

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        status = self.rng.choice(self.spec.status_codes)
        emit(self.fault, {"status_code": status})
        raise SimulatedAPIError(status)


class RateLimitInterceptor(Interceptor):
    """429s on probability or when the rolling call budget is exhausted.

    The budget is a per-tool window over the *call sequence* (the last
    ``window_calls`` calls may contain at most ``burst_budget``
    non-limited calls) — call-count based, never wall-clock based, so it
    stays deterministic under invariant #1.
    """

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

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        retry_after = round(self.rng.uniform(*self.spec.retry_after_s), 1)
        emit(self.fault, {"retry_after_s": retry_after})
        raise SimulatedRateLimit(retry_after)


class ToolVanishInterceptor(Interceptor):
    """Once triggered, the tool is gone for the remainder of the run."""

    kind = "raising"
    fault = FaultType.TOOL_VANISH

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        super().__init__(spec, rng)
        self._vanished: set[str] = set()

    def is_vanished(self, tool_name: str) -> bool:
        return tool_name in self._vanished

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        self._vanished.add(tool_name)
        emit(self.fault, {"sticky": False})
        raise ToolVanishedError(tool_name)


class TimeoutInterceptor(Interceptor):
    kind = "raising"
    fault = FaultType.TIMEOUT

    def inject(self, tool_name: str, emit: EmitFn) -> NoReturn:
        deadline = self.spec.timeout_after_s
        emit(self.fault, {"timeout_after_s": deadline})
        time.sleep(deadline)
        raise SimulatedTimeout(deadline)


class LatencyInterceptor(Interceptor):
    kind = "latency"
    fault = FaultType.LATENCY

    def apply(self, tool_name: str, emit: EmitFn) -> None:
        delay = round(self.rng.uniform(*self.spec.delay_s), 3)
        emit(self.fault, {"delay_s": delay})
        time.sleep(delay)


class MalformedInterceptor(Interceptor):
    """Truncates the tool's output into broken JSON / garbage text."""

    kind = "corrupting"
    fault = FaultType.MALFORMED

    def corrupt(self, result: Any, emit: EmitFn) -> str:
        text = result if isinstance(result, str) else json.dumps(result, default=str)
        cut = max(1, int(len(text) * self.rng.uniform(0.25, 0.6)))
        emit(self.fault, {"original_len": len(text), "truncated_to": cut})
        return text[:cut]


class SilentLieInterceptor(Interceptor):
    """Perturbs numeric values so the output is wrong but well-formed.

    Rule: a bare numeric result is multiplied by ``lie_factor``
    (calculator-style); in text/JSON the first number gets a ±
    ``lie_offset`` shift (temperature-style) and any further numbers are
    multiplied. The event detail carries original and lied values so the
    verifier can prove the deception.
    """

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
        seen = 0

        def replace(match: re.Match[str]) -> str:
            nonlocal seen
            seen += 1
            token = match.group(0)
            value = float(token)
            is_int = "." not in token
            lied = self._lie_number(
                int(value) if is_int else value, factor=seen > 1
            )
            return str(lied)

        return _NUMBER_RE.sub(replace, text)


class ContextDropInterceptor:
    """Deletes the last K steps from a smolagents agent's memory.

    Coded defensively against smolagents internals changing: any missing
    attribute or unexpected shape makes this a silent no-op. The task
    step itself (``TaskStep``) is never deleted.
    """

    fault = FaultType.CONTEXT_DROP

    def __init__(self, spec: FaultSpec, rng: ChaosRandom) -> None:
        self.spec = spec
        self.rng = rng

    def maybe_drop(self, agent: Any, emit: EmitFn) -> None:
        if not self.rng.should_fire(self.spec.probability):
            return
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
    # Name check first so this works even if smolagents moves the class;
    # isinstance covers subclasses with different names.
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
