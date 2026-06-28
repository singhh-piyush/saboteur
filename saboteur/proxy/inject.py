"""The wire fault pipeline: inject the 8-fault taxonomy on one chat request.

This is the *injection mechanism* the proxy adds; every fault *decision* and
*parameter draw* comes from the chaos core's interceptors (reused, not forked).
For one request, under the session lock, we mirror ``ChaosEngine._invoke``'s
discipline — draw every applicable decision in profile order first, then act in
kind order — but the actions speak HTTP (sleep + 504, 500/503, 429, truncate the
response, perturb a request tool-result, drop messages, strip a tool) instead of
raising / sleeping synchronously.

Mapping (CLAUDE.md fault taxonomy):
- ``latency``      → ``await asyncio.sleep`` before forwarding.
- ``api_error``    → 500/503, do not forward.
- ``rate_limit``   → 429 + ``Retry-After`` (rolling call-count budget).
- ``timeout``      → sleep the deadline, then 504.
- ``malformed``    → truncate the upstream response body.
- ``silent_lie``   → perturb the last number in the last tool-result *message*
  of the request (the deception probe; streaming-agnostic).
- ``context_drop`` → drop the last K messages from the forwarded request.
- ``tool_vanish``  → strip a tool from the request's ``tools`` array, sticky for
  the rest of the session.

Transparency contract: the original request/response bytes are forwarded
unchanged unless a fault actually mutated them, so calm_seas — and any request
where no fault fires — is content-identical to hitting the upstream directly.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import Response
from fastapi.responses import JSONResponse, StreamingResponse

from saboteur.agents.outcomes import StepRecord, classify_recoveries
from saboteur.chaos.events import FaultType
from saboteur.chaos.interceptors import (
    ApiErrorInterceptor,
    Interceptor,
    LatencyInterceptor,
    MalformedInterceptor,
    RateLimitInterceptor,
    SilentLieInterceptor,
    TimeoutInterceptor,
    ToolVanishInterceptor,
)

from . import forward
from .session import ProxyRun, ProxySession

# emit callback factory: name → (fault, detail) sink. Loosely typed (the
# interceptors' EmitFn signature) to keep call sites readable.
EmitFactory = Callable[[str | None], Callable[[FaultType, dict[str, Any]], None]]

# The synthetic "tool name" the transport/response/context faults key on (their
# rate-limit budget window and ``applies_to`` filter run against this).
WIRE_NAME = "chat.completions"
_UPSTREAM_SUBPATH = "chat/completions"


async def inject_chat_completion(
    run: ProxyRun,
    session: ProxySession,
    *,
    raw_body: bytes,
    parsed: dict[str, Any],
    headers: Mapping[str, str],
) -> Response:
    """Run the fault pipeline for one chat-completions request → a Response."""
    async with session.lock:
        return await _inject(run, session, raw_body=raw_body, parsed=parsed, headers=headers)


async def _inject(
    run: ProxyRun,
    session: ProxySession,
    *,
    raw_body: bytes,
    parsed: dict[str, Any],
    headers: Mapping[str, str],
) -> Response:
    agent_id = session.agent_id
    step = session.next_step()
    run.emit_step_start(agent_id, step)

    # Tool signature for recovery diffing — captured BEFORE any mutation (a
    # context_drop may delete the very message we read it from).
    messages: list[Any] = parsed.get("messages") or []
    tool_name, tool_args = _last_assistant_toolcall(messages)

    fired: list[str] = []

    def make_emit(tool: str | None):
        def emit(ft: FaultType, detail: dict[str, Any]) -> None:
            fired.append(str(ft))
            run.emit_fault(agent_id, step, str(ft), tool=tool, detail=detail)

        return emit

    # --- draw all decisions first (profile order), one per applicable spec ---
    decisions: list[tuple[Interceptor, str, bool]] = []
    for ic in session.tool_interceptors:
        name = _wire_name(ic, parsed)
        if name is None or not ic.applies_to(name):
            continue
        decisions.append((ic, name, ic.decide(name)))
    ctx_decisions = [
        (ic, ic.rng.should_fire(ic.spec.probability))
        for ic in session.context_interceptors
    ]

    mutated = False

    # --- request-side, non-corrupting mutations (apply regardless) ---
    # (a) sticky vanish: strip any already-vanished tools every request.
    if session.vanish is not None:
        already = [n for n in _tool_names(parsed) if session.vanish.is_vanished(n)]
        if already and _strip_tools(parsed, set(already)):
            mutated = True
    # (b) context_drop.
    for cic, did_fire in ctx_decisions:
        if did_fire and cic.spec.drop_last_k:
            dropped = _drop_messages(parsed, cic.spec.drop_last_k)
            if dropped:
                mutated = True
                make_emit(None)(cic.fault, {"dropped_steps": dropped})
    # (c) tool_vanish (fresh).
    for ic, name, did_fire in decisions:
        if did_fire and isinstance(ic, ToolVanishInterceptor):
            ic.vanish(name, make_emit(name))  # marks + emits, no raise
            if _strip_tools(parsed, {name}):
                mutated = True

    # --- transport: latency (before any early return) ---
    for ic, _name, did_fire in decisions:
        if did_fire and isinstance(ic, LatencyInterceptor):
            await asyncio.sleep(ic.draw_delay(make_emit(WIRE_NAME)))

    # --- raising: first fired wins (api_error / rate_limit / timeout) ---
    early: Response | None = None
    for ic, _name, did_fire in decisions:
        if not did_fire:
            continue
        if isinstance(ic, ApiErrorInterceptor):
            status = ic.draw_status(make_emit(WIRE_NAME))
            early = JSONResponse(
                status_code=status,
                content=_openai_error("Simulated upstream API error", "server_error", status),
            )
            break
        if isinstance(ic, RateLimitInterceptor):
            retry_after = ic.draw_retry_after(make_emit(WIRE_NAME))
            early = JSONResponse(
                status_code=429,
                content=_openai_error("Rate limit exceeded (simulated)", "rate_limit_exceeded"),
                headers={"Retry-After": str(retry_after)},
            )
            break
        if isinstance(ic, TimeoutInterceptor):
            deadline = ic.draw_deadline(make_emit(WIRE_NAME))
            await asyncio.sleep(deadline)
            early = JSONResponse(
                status_code=504,
                content=_openai_error("Upstream request timed out (simulated)", "timeout"),
            )
            break

    # --- forward (unless we already short-circuited) ---
    if early is not None:
        response: Response = early
        errored = True
    else:
        # silent_lie is "corrupting" — only acts when we actually forward.
        for ic, name, did_fire in decisions:
            if did_fire and isinstance(ic, SilentLieInterceptor):
                if _lie_request_tool_result(parsed, ic, make_emit):
                    mutated = True

        stream = bool(parsed.get("stream"))
        malformed = next(
            (
                ic
                for ic, _n, f in decisions
                if f and isinstance(ic, MalformedInterceptor)
            ),
            None,
        )
        body = json.dumps(parsed).encode("utf-8") if mutated else raw_body

        if stream and malformed is None:
            response = StreamingResponse(
                forward.stream_passthrough(_UPSTREAM_SUBPATH, headers, body),
                media_type="text/event-stream",
            )
            errored = False
        else:
            status, up_headers, content = await forward.forward_nonstream(
                _UPSTREAM_SUBPATH, headers, body
            )
            media = up_headers.get("content-type", "application/json")
            if malformed is not None:
                text = content.decode("utf-8", errors="replace")
                content = malformed.corrupt(text, make_emit(WIRE_NAME)).encode("utf-8")
                errored = True
            else:
                errored = False
                _accumulate_tokens(session, content)
            response = Response(content=content, status_code=status, media_type=media)

    # --- finalize the step: record, tool_call, recovery ---
    faulted = bool(fired)
    record = StepRecord(
        step=step,
        tool_name=tool_name,
        arguments=tool_args,
        faulted=faulted,
        fault_types=tuple(fired),
        errored=errored,
        observation=None,
    )
    session.history.append(record)
    if tool_name is not None:
        run.emit_tool_call(
            agent_id,
            step,
            tool_name,
            tool_args,
            sabotaged=faulted,
            fault_types=list(fired),
            errored=errored,
        )
    recoveries = classify_recoveries(session.history, terminal=False)
    if recoveries and recoveries[-1].step == step:
        rec = recoveries[-1]
        run.emit_recovery(agent_id, step, str(rec.kind), rec.after_fault)

    run.touch()
    return response


async def passthrough_chat(
    raw_body: bytes, headers: Mapping[str, str], *, stream: bool
) -> Response:
    """Forward a chat request verbatim (no run header → transparent proxy)."""
    if stream:
        return StreamingResponse(
            forward.stream_passthrough(_UPSTREAM_SUBPATH, headers, raw_body),
            media_type="text/event-stream",
        )
    status, up_headers, content = await forward.forward_nonstream(
        _UPSTREAM_SUBPATH, headers, raw_body
    )
    return Response(
        content=content,
        status_code=status,
        media_type=up_headers.get("content-type", "application/json"),
    )


# ---------------------------------------------------------------------------
# Wire helpers
# ---------------------------------------------------------------------------


def _wire_name(ic: Interceptor, parsed: dict[str, Any]) -> str | None:
    """The name an interceptor decides against this request (None = N/A)."""
    if ic.fault is FaultType.SILENT_LIE:
        idx, name = _last_tool_result(parsed.get("messages") or [])
        if idx is None:
            return None  # nothing to lie about this request
        return name or ""  # "" = a tool-result with an unknown tool name
    if ic.fault is FaultType.TOOL_VANISH:
        assert isinstance(ic, ToolVanishInterceptor)
        for name in _tool_names(parsed):
            if not ic.is_vanished(name):
                return name
        return None
    return WIRE_NAME


def _tool_names(parsed: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for tool in parsed.get("tools") or []:
        if isinstance(tool, dict):
            name = (tool.get("function") or {}).get("name")
            if isinstance(name, str):
                names.append(name)
    return names


def _strip_tools(parsed: dict[str, Any], remove: set[str]) -> bool:
    tools = parsed.get("tools")
    if not isinstance(tools, list):
        return False
    kept = [
        t
        for t in tools
        if not (isinstance(t, dict) and (t.get("function") or {}).get("name") in remove)
    ]
    if len(kept) == len(tools):
        return False
    parsed["tools"] = kept
    return True


def _drop_messages(parsed: dict[str, Any], k: int) -> int:
    """Drop the last ``k`` messages, never the leading system message."""
    messages = parsed.get("messages")
    if not isinstance(messages, list) or not messages:
        return 0
    keep_system = isinstance(messages[0], dict) and messages[0].get("role") == "system"
    floor = 1 if keep_system else 0
    drop = min(k, len(messages) - floor)
    if drop <= 0:
        return 0
    del messages[len(messages) - drop :]
    return drop


def _last_assistant_toolcall(messages: list[Any]) -> tuple[str | None, Any]:
    for msg in reversed(messages):
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            fn = (tool_calls[0] or {}).get("function") or {}
            name = fn.get("name")
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except (TypeError, ValueError):
                args = raw
            return name, args
    return None, None


def _last_tool_result(messages: list[Any]) -> tuple[int | None, str | None]:
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, dict) and msg.get("role") == "tool":
            name = msg.get("name") or _resolve_tool_name(messages, msg.get("tool_call_id"))
            return i, name
    return None, None


def _resolve_tool_name(messages: list[Any], tool_call_id: Any) -> str | None:
    if not tool_call_id:
        return None
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                if isinstance(tc, dict) and tc.get("id") == tool_call_id:
                    return (tc.get("function") or {}).get("name")
    return None


def _lie_request_tool_result(
    parsed: dict[str, Any], ic: SilentLieInterceptor, make_emit: EmitFactory
) -> bool:
    """Perturb the last tool-result message's content in place (if a string)."""
    messages = parsed.get("messages") or []
    idx, name = _last_tool_result(messages)
    if idx is None:
        return False
    msg = messages[idx]
    content = msg.get("content")
    if not isinstance(content, str):
        return False
    msg["content"] = ic.corrupt(content, make_emit(name or None))
    return True


def _accumulate_tokens(session: ProxySession, content: bytes) -> None:
    try:
        usage = (json.loads(content) or {}).get("usage") or {}
        total = usage.get("total_tokens")
        if total is None:
            total = (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0)
        session.tokens += int(total)
    except Exception:
        pass


def _openai_error(message: str, type_: str, code: Any = None) -> dict[str, Any]:
    return {"error": {"message": message, "type": type_, "param": None, "code": code}}
