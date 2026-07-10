
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable

from saboteur.agents.outcomes import StepRecord, classify_recoveries
from saboteur.chaos.events import FaultType
from saboteur.chaos.interceptors import (
    LatencyInterceptor,
    MalformedInterceptor,
    RateLimitInterceptor,
    SilentLieInterceptor,
    ToolVanishInterceptor,
)
from saboteur.telemetry import build
from saboteur.telemetry.schema import TelemetryEvent

from . import jsonrpc

if TYPE_CHECKING:
    from saboteur.proxy.session import ProxySession

import asyncio

Emit = Callable[[TelemetryEvent], None]
UpstreamCall = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
FaultEmit = Callable[[FaultType, dict[str, Any]], None]

MCP_FAULTS = frozenset(
    {
        FaultType.LATENCY,
        FaultType.RATE_LIMIT,
        FaultType.TOOL_VANISH,
        FaultType.MALFORMED,
        FaultType.SILENT_LIE,
    }
)


async def handle_tools_call(
    session: "ProxySession",
    *,
    run_id: str,
    params: dict[str, Any],
    jsonrpc_id: Any,
    emit: Emit,
    upstream_call: UpstreamCall,
) -> jsonrpc.Message:
    agent_id = session.agent_id
    step = session.next_step()
    emit(build.step_start_event(run_id, agent_id, step))

    tool_name = params.get("name")
    tool_args = params.get("arguments")
    name = tool_name if isinstance(tool_name, str) else ""
    fired: list[str] = []

    def emit_fault(tool: str | None) -> FaultEmit:
        def _emit(ft: FaultType, detail: dict[str, Any]) -> None:
            fired.append(str(ft))
            emit(build.fault_event(run_id, agent_id, step, str(ft), tool=tool, detail=detail))

        return _emit

    if session.vanish is not None and name and session.vanish.is_vanished(name):
        emit_fault(tool_name)(FaultType.TOOL_VANISH, {"sticky": True})
        return _finalize(
            session, run_id, agent_id, step, tool_name, tool_args, fired,
            errored=True, result=_not_found_result(tool_name), jsonrpc_id=jsonrpc_id, emit=emit,
        )

    decisions: list[tuple[Any, bool]] = [
        (ic, ic.decide(name))
        for ic in session.tool_interceptors
        if ic.fault in MCP_FAULTS and ic.applies_to(name)
    ]

    for ic, did_fire in decisions:
        if did_fire and isinstance(ic, LatencyInterceptor):
            await asyncio.sleep(ic.draw_delay(emit_fault(tool_name)))

    early: dict[str, Any] | None = None
    errored = False
    for ic, did_fire in decisions:
        if not did_fire:
            continue
        if isinstance(ic, RateLimitInterceptor):
            retry = ic.draw_retry_after(emit_fault(tool_name))
            early = _rate_limit_result(retry)
            errored = True
            break
        if isinstance(ic, ToolVanishInterceptor):
            ic.vanish(name, emit_fault(tool_name))  # marks sticky + emits
            early = _not_found_result(tool_name)
            errored = True
            break

    if early is not None:
        result = early
    else:
        result = await upstream_call(params)
        for ic, did_fire in decisions:
            if not did_fire:
                continue
            if isinstance(ic, (MalformedInterceptor, SilentLieInterceptor)):
                result, corrupted = _apply_corrupt(result, ic, emit_fault(tool_name))
                if corrupted and isinstance(ic, MalformedInterceptor):
                    errored = True
                break

    return _finalize(
        session, run_id, agent_id, step, tool_name, tool_args, fired,
        errored=errored, result=result, jsonrpc_id=jsonrpc_id, emit=emit,
    )


def handle_tools_list(session: "ProxySession", result: dict[str, Any]) -> dict[str, Any]:
    vanish = session.vanish
    if vanish is None:
        return result
    tools = result.get("tools")
    if not isinstance(tools, list):
        return result

    def _vanished(t: Any) -> bool:
        n = t.get("name") if isinstance(t, dict) else None
        return isinstance(n, str) and vanish.is_vanished(n)

    kept = [t for t in tools if not _vanished(t)]
    if len(kept) == len(tools):
        return result
    return {**result, "tools": kept}




def _finalize(
    session: "ProxySession",
    run_id: str,
    agent_id: int,
    step: int,
    tool_name: str | None,
    tool_args: Any,
    fired: list[str],
    *,
    errored: bool,
    result: dict[str, Any],
    jsonrpc_id: Any,
    emit: Emit,
) -> jsonrpc.Message:
    faulted = bool(fired)
    session.history.append(
        StepRecord(
            step=step,
            tool_name=tool_name,
            arguments=tool_args,
            faulted=faulted,
            fault_types=tuple(fired),
            errored=errored,
            observation=None,
        )
    )
    emit(
        build.tool_call_event(
            run_id, agent_id, step, tool_name, tool_args,
            sabotaged=faulted, fault_types=list(fired), errored=errored,
        )
    )
    recoveries = classify_recoveries(session.history, terminal=False)
    if recoveries and recoveries[-1].step == step:
        rec = recoveries[-1]
        emit(build.recovery_event(run_id, agent_id, step, str(rec.kind), rec.after_fault))
    return jsonrpc.result_response(jsonrpc_id, result)


def _text_result(text: str, *, is_error: bool) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _rate_limit_result(retry_after_s: float) -> dict[str, Any]:
    return _text_result(
        f"Rate limit exceeded (simulated). Retry after {retry_after_s}s.", is_error=True
    )


def _not_found_result(tool_name: str | None) -> dict[str, Any]:
    return _text_result(
        f"Tool '{tool_name}' not found (simulated tool_vanish).", is_error=True
    )


def _apply_corrupt(
    result: dict[str, Any], interceptor: Any, emit_fault: FaultEmit
) -> tuple[dict[str, Any], bool]:
    content = result.get("content")
    if not isinstance(content, list):
        return result, False
    for i, block in enumerate(content):
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(
            block.get("text"), str
        ):
            new_block = {**block, "text": interceptor.corrupt(block["text"], emit_fault)}
            new_content = list(content)
            new_content[i] = new_block
            return {**result, "content": new_content}, True
    return result, False
