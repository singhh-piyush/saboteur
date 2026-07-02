"""Wire-proxy tests — LLM-free, with a stubbed upstream.

The upstream (real llama.cpp) is replaced by monkeypatching the proxy's
``forward`` functions with a fake that records the forwarded body and returns a
canned OpenAI response. Covers:

- transparency contract: calm_seas / no-fault forwards the body unchanged
  (non-streaming and streaming);
- every fault at probability 1.0 (api_error, rate_limit, timeout, latency,
  malformed, silent_lie, context_drop, tool_vanish + stickiness);
- determinism (same profile+seed+agent_id+request sequence → same faults);
- request-stream recovery classification (retry / reformulate / fallback_tool);
- crash isolation (one session's vanish never touches another);
- replay parity (re-scoring the written JSONL == the persisted scorecard).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from saboteur.chaos.profile import ChaosProfile, FaultSpec
from saboteur.proxy import forward, inject
from saboteur.proxy.session import ProxyRun, manager
from saboteur.telemetry.bus import TelemetryBus
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.harness.scoring import Scorecard, score

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CANNED = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "the answer is 42"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
}
_CANNED_BYTES = json.dumps(_CANNED).encode("utf-8")


class FakeUpstream:
    """Records forwarded bodies; returns a canned completion."""

    def __init__(self) -> None:
        self.bodies: list[bytes] = []

    async def forward_nonstream(
        self, subpath: str, headers: Any, body: bytes, *, method: str = "POST"
    ) -> tuple[int, httpx.Headers, bytes]:
        self.bodies.append(body)
        return 200, httpx.Headers({"content-type": "application/json"}), _CANNED_BYTES

    async def stream_passthrough(self, subpath, headers, body):
        self.bodies.append(body)
        yield b'data: {"choices":[{"delta":{"content":"42"}}]}\n\n'
        yield b"data: [DONE]\n\n"

    def install(self, monkeypatch: pytest.MonkeyPatch) -> "FakeUpstream":
        monkeypatch.setattr(forward, "forward_nonstream", self.forward_nonstream)
        monkeypatch.setattr(forward, "stream_passthrough", self.stream_passthrough)
        return self


def _profile(*faults: dict[str, Any], seed: int = 7, name: str = "probe") -> ChaosProfile:
    return ChaosProfile(name=name, seed=seed, faults=[FaultSpec(**f) for f in faults])


async def _make_run(profile: ChaosProfile, *, n_agents: int = 1, tmp: Path) -> ProxyRun:
    """A ProxyRun with an unbound bus (events still captured in run.events)."""
    bus = TelemetryBus()  # unbound: emit() is a silent no-op, run.events still fills

    async def _noop() -> None:
        return None

    writer_task = asyncio.create_task(_noop())
    return ProxyRun("proxy-test", profile, n_agents, bus, writer_task, runs_dir=tmp)


def _chat(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    stream: bool = False,
) -> tuple[bytes, dict[str, Any]]:
    body: dict[str, Any] = {"model": "m", "messages": messages, "stream": stream}
    if tools is not None:
        body["tools"] = tools
    return json.dumps(body).encode("utf-8"), body


def _tool(name: str) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def _assistant_call(name: str, args: dict[str, Any], call_id: str = "c1") -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
    }


def _basic_messages() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
        _assistant_call("weather", {"city": "Tokyo"}),
        {"role": "tool", "tool_call_id": "c1", "name": "weather", "content": "22.0°C (71.6°F)"},
    ]


async def _send(run: ProxyRun, agent_id: int, raw: bytes, parsed: dict[str, Any]):
    session = run.session(agent_id)
    return await inject.inject_chat_completion(
        run, session, raw_body=raw, parsed=parsed, headers={}
    )


def _faults(run: ProxyRun) -> list[str | None]:
    return [e.fault for e in run.events if e.event == "fault_injected"]


async def _read_stream(resp) -> bytes:
    chunks: list[bytes] = []
    async for c in resp.body_iterator:
        chunks.append(c if isinstance(c, bytes) else c.encode())
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# Transparency contract
# ---------------------------------------------------------------------------


async def test_passthrough_calm_seas_unchanged_nonstream(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(_profile(), tmp=tmp_path)  # no faults
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 200
    assert resp.body == _CANNED_BYTES
    # Forwarded body is byte-identical to the original request.
    assert fake.bodies == [raw]
    assert _faults(run) == []


async def test_passthrough_streaming_preserved(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(_profile(), tmp=tmp_path)
    raw, parsed = _chat(_basic_messages(), stream=True)

    resp = await _send(run, 0, raw, parsed)
    body = await _read_stream(resp)

    assert b"[DONE]" in body
    assert fake.bodies == [raw]
    assert _faults(run) == []


async def test_streaming_usage_chunk_counted(monkeypatch, tmp_path):
    """A trailing usage chunk (stream_options.include_usage) feeds waste_factor."""
    fake = FakeUpstream().install(monkeypatch)

    async def stream_with_usage(subpath, headers, body):
        fake.bodies.append(body)
        yield b'data: {"choices":[{"delta":{"content":"42"}}],"usage":null}\n\n'
        yield b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":7,"total_tokens":17}}\n\n'
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(forward, "stream_passthrough", stream_with_usage)
    run = await _make_run(_profile(), tmp=tmp_path)
    raw, parsed = _chat(_basic_messages(), stream=True)

    resp = await _send(run, 0, raw, parsed)
    body = await _read_stream(resp)  # drain — bytes still passthrough-identical

    assert b"[DONE]" in body
    assert run.session(0).tokens == 17


# ---------------------------------------------------------------------------
# Each fault at probability 1.0
# ---------------------------------------------------------------------------


async def test_api_error_returns_5xx_without_forwarding(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(_profile({"type": "api_error", "probability": 1.0}), tmp=tmp_path)
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code in (500, 503)
    assert fake.bodies == []  # never forwarded
    assert "api_error" in _faults(run)


async def test_rate_limit_returns_429_with_retry_after(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    run = await _make_run(
        _profile({"type": "rate_limit", "probability": 1.0, "retry_after_s": [2.0, 4.0]}),
        tmp=tmp_path,
    )
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 429
    assert "Retry-After" in resp.headers
    assert float(resp.headers["Retry-After"]) >= 2.0
    assert "rate_limit" in _faults(run)


async def test_timeout_sleeps_then_504(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr(inject.asyncio, "sleep", fake_sleep)
    run = await _make_run(
        _profile({"type": "timeout", "probability": 1.0, "timeout_after_s": 9.0}),
        tmp=tmp_path,
    )
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 504
    assert 9.0 in slept
    assert "timeout" in _faults(run)


async def test_latency_sleeps_then_forwards(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr(inject.asyncio, "sleep", fake_sleep)
    run = await _make_run(
        _profile({"type": "latency", "probability": 1.0, "delay_s": [0.5, 1.0]}),
        tmp=tmp_path,
    )
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 200
    assert slept and slept[0] >= 0.5
    assert fake.bodies == [raw]  # still forwarded, unchanged
    assert "latency" in _faults(run)
    # The drawn delay is lifted onto the event's latency_ms field.
    lat = next(e for e in run.events if e.fault == "latency")
    assert lat.latency_ms == pytest.approx(slept[0] * 1000)


async def test_malformed_truncates_response(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    run = await _make_run(_profile({"type": "malformed", "probability": 1.0}), tmp=tmp_path)
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 200
    assert len(resp.body) < len(_CANNED_BYTES)  # truncated
    with pytest.raises(json.JSONDecodeError):
        json.loads(resp.body)  # broken JSON
    assert "malformed" in _faults(run)


async def test_silent_lie_perturbs_request_tool_result(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(
        _profile({"type": "silent_lie", "probability": 1.0, "target_tools": ["weather"]}),
        tmp=tmp_path,
    )
    raw, parsed = _chat(_basic_messages())

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 200
    forwarded = json.loads(fake.bodies[0])
    lied = forwarded["messages"][-1]["content"]
    assert lied != "22.0°C (71.6°F)"  # the reading was perturbed
    assert "22.0" in lied  # only the LAST number (°F) is lied; °C stays true
    assert "silent_lie" in _faults(run)


async def test_context_drop_drops_messages(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(
        _profile({"type": "context_drop", "probability": 1.0, "drop_last_k": 2}),
        tmp=tmp_path,
    )
    raw, parsed = _chat(_basic_messages())  # 4 messages

    resp = await _send(run, 0, raw, parsed)

    assert resp.status_code == 200
    forwarded = json.loads(fake.bodies[0])
    assert len(forwarded["messages"]) == 2  # 4 - 2 dropped
    assert forwarded["messages"][0]["role"] == "system"  # system preserved
    assert "context_drop" in _faults(run)


async def test_tool_vanish_strips_tool_and_is_sticky(monkeypatch, tmp_path):
    fake = FakeUpstream().install(monkeypatch)
    run = await _make_run(
        _profile({"type": "tool_vanish", "probability": 1.0, "target_tools": ["weather"]}),
        tmp=tmp_path,
    )
    tools = [_tool("weather"), _tool("calculator")]

    raw1, p1 = _chat(_basic_messages(), tools=tools)
    await _send(run, 0, raw1, p1)
    forwarded1 = json.loads(fake.bodies[0])
    names1 = [t["function"]["name"] for t in forwarded1["tools"]]
    assert "weather" not in names1 and "calculator" in names1
    assert "tool_vanish" in _faults(run)

    # Sticky: a second request still has weather stripped.
    raw2, p2 = _chat(_basic_messages(), tools=tools)
    await _send(run, 0, raw2, p2)
    forwarded2 = json.loads(fake.bodies[1])
    names2 = [t["function"]["name"] for t in forwarded2["tools"]]
    assert "weather" not in names2 and "calculator" in names2


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


async def test_determinism_same_seed_same_fault_sequence(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    spec = {"type": "api_error", "probability": 0.5}

    async def run_once() -> list[str | None]:
        run = await _make_run(_profile(spec, seed=1337), tmp=tmp_path)
        for _ in range(20):
            raw, parsed = _chat(_basic_messages())
            await _send(run, 3, raw, parsed)
        return [e.fault for e in run.events if e.event == "fault_injected"]

    first = await run_once()
    second = await run_once()
    assert first == second
    assert first  # at p=0.5 over 20 calls, at least one fired


# ---------------------------------------------------------------------------
# Recovery classification on the request stream
# ---------------------------------------------------------------------------


async def test_recovery_retry_reformulate_fallback(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    # Every completion api_errors, so each request after the first is a reaction.
    run = await _make_run(_profile({"type": "api_error", "probability": 1.0}), tmp=tmp_path)

    def msgs_with(call: dict[str, Any]) -> list[dict[str, Any]]:
        return [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}, call]

    seq = [
        _assistant_call("weather", {"city": "Tokyo"}),       # step1: fault
        _assistant_call("weather", {"city": "Tokyo"}),       # step2: same → retry
        _assistant_call("weather", {"city": "Kyoto"}),       # step3: new args → reformulate
        _assistant_call("web_search", {"q": "Tokyo temp"}),  # step4: new tool → fallback_tool
    ]
    for call in seq:
        raw, parsed = _chat(msgs_with(call))
        await _send(run, 0, raw, parsed)

    recoveries = [e.recovery for e in run.events if e.event == "recovery_action"]
    assert recoveries == ["retry", "reformulate", "fallback_tool"]


# ---------------------------------------------------------------------------
# Crash isolation
# ---------------------------------------------------------------------------


async def test_crash_isolation_vanish_state_per_session(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    run = await _make_run(
        _profile({"type": "tool_vanish", "probability": 1.0, "target_tools": ["weather"]}),
        n_agents=2,
        tmp=tmp_path,
    )
    tools = [_tool("weather"), _tool("calculator")]

    # Agent 0 triggers the vanish.
    raw, parsed = _chat(_basic_messages(), tools=tools)
    await _send(run, 0, raw, parsed)

    sess0 = run.session(0)
    sess1 = run.session(1)
    assert sess0 is not sess1
    assert sess0.vanish is not None and sess0.vanish.is_vanished("weather")
    # Agent 1's independent session has NOT vanished anything yet.
    assert sess1.vanish is not None and not sess1.vanish.is_vanished("weather")


# ---------------------------------------------------------------------------
# Replay parity (real bus + JSONL writer via the manager)
# ---------------------------------------------------------------------------


async def test_replay_parity_rescore_equals_persisted(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    profile = _profile(
        {"type": "api_error", "probability": 0.4},
        {"type": "silent_lie", "probability": 0.5, "target_tools": ["weather"]},
        seed=99,
    )
    run = await manager.create("proxy-replay-test", profile, 2, runs_dir=tmp_path)
    for agent_id in (0, 1):
        for _ in range(6):
            raw, parsed = _chat(_basic_messages())
            await _send(run, agent_id, raw, parsed)
    await run.finish()

    persisted = Scorecard.model_validate_json(
        (tmp_path / "proxy-replay-test.scorecard.json").read_text()
    )
    rescored = score(
        read_jsonl(tmp_path / "proxy-replay-test.jsonl"),
        [],
        run_id="proxy-replay-test",
        profile=profile.name,
    )
    assert rescored.model_dump() == persisted.model_dump()
    # Behavioral tier present; oracle-gated tier null + reason (no oracle / BYO).
    assert persisted.survival_rate is None
    assert persisted.survival_rate_reason == "no_oracle"
    assert persisted.n_agents == 2


async def test_finish_emits_terminals_and_is_idempotent(monkeypatch, tmp_path):
    FakeUpstream().install(monkeypatch)
    run = await manager.create("proxy-finish-test", _profile(), 1, runs_dir=tmp_path)
    raw, parsed = _chat(_basic_messages())
    await _send(run, 0, raw, parsed)
    await run.finish()
    await run.finish()  # idempotent — no double terminals

    done = [e for e in run.events if e.event == "agent_done"]
    run_finished = [e for e in run.events if e.event == "run_finished"]
    assert len(done) == 1
    assert len(run_finished) == 1
    assert done[0].payload["success"] is None


# ---------------------------------------------------------------------------
# Headerless capture-all mode ("one env var, zero code change")
# ---------------------------------------------------------------------------


@pytest.fixture()
def clean_capture():
    """The manager is a module singleton — never leak capture state across tests."""
    yield
    manager._capture_run = None


def _start_messages() -> list[dict[str, Any]]:
    """A conversation-start request: no assistant turn yet."""
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task"},
    ]


async def test_capture_agent_id_allocation(monkeypatch, tmp_path, clean_capture):
    FakeUpstream().install(monkeypatch)
    run = await manager.create(
        "capture-alloc", _profile(), 3, runs_dir=tmp_path, capture_all=True
    )

    # Conversation start → agent 0; continuations stick to it.
    assert run.capture_agent_id({"messages": _start_messages()}) == 0
    assert run.capture_agent_id({"messages": _basic_messages()}) == 0
    # New conversation start → agent 1.
    assert run.capture_agent_id({"messages": _start_messages()}) == 1
    assert run.capture_agent_id({"messages": _basic_messages()}) == 1
    # Third and fourth starts: allocation caps at n_agents - 1.
    assert run.capture_agent_id({"messages": _start_messages()}) == 2
    assert run.capture_agent_id({"messages": _start_messages()}) == 2
    await run.finish()


async def test_capture_run_absorbs_headerless_and_faults_fire(
    monkeypatch, tmp_path, clean_capture
):
    fake = FakeUpstream().install(monkeypatch)
    run = await manager.create(
        "capture-faults",
        _profile({"type": "silent_lie", "probability": 1.0, "target_tools": ["weather"]}),
        1,
        runs_dir=tmp_path,
        capture_all=True,
    )
    assert manager.capture_run is run

    from starlette.testclient import TestClient

    from saboteur.api import app

    raw, _ = _chat(_basic_messages())
    with TestClient(app) as client:
        resp = client.post("/v1/chat/completions", content=raw)  # NO headers
    assert resp.status_code == 200

    # The fault fired inside the capture run, on the forwarded body.
    assert "silent_lie" in _faults(run)
    forwarded = json.loads(fake.bodies[0])
    assert forwarded["messages"][-1]["content"] != "22.0°C (71.6°F)"
    await run.finish()


async def test_headers_override_capture(monkeypatch, tmp_path, clean_capture):
    FakeUpstream().install(monkeypatch)
    capture = await manager.create(
        "capture-bg", _profile(), 1, runs_dir=tmp_path, capture_all=True
    )
    headered = await manager.create(
        "capture-target",
        _profile({"type": "api_error", "probability": 1.0}),
        1,
        runs_dir=tmp_path,
    )

    from starlette.testclient import TestClient

    from saboteur.api import app

    raw, _ = _chat(_basic_messages())
    with TestClient(app) as client:
        resp = client.post(
            "/v1/chat/completions",
            content=raw,
            headers={"X-Saboteur-Run-Id": "capture-target", "X-Saboteur-Agent-Id": "0"},
        )
    # Routed to the headered run (its api_error fired), not the capture run.
    assert resp.status_code in (500, 503)
    assert "api_error" in _faults(headered)
    assert capture.events == [e for e in capture.events if e.event == "run_started"]
    await headered.finish()
    await capture.finish()


async def test_unknown_run_header_passes_through_never_captured(
    monkeypatch, tmp_path, clean_capture
):
    fake = FakeUpstream().install(monkeypatch)
    capture = await manager.create(
        "capture-strict", _profile({"type": "api_error", "probability": 1.0}),
        1, runs_dir=tmp_path, capture_all=True,
    )

    from starlette.testclient import TestClient

    from saboteur.api import app

    raw, _ = _chat(_basic_messages())
    with TestClient(app) as client:
        resp = client.post(
            "/v1/chat/completions",
            content=raw,
            headers={"X-Saboteur-Run-Id": "no-such-run"},
        )
    # Explicitly-targeted unknown run → transparent passthrough, NOT captured.
    assert resp.status_code == 200
    assert resp.content == _CANNED_BYTES
    assert fake.bodies == [raw]
    assert _faults(capture) == []
    await capture.finish()


async def test_second_capture_run_finishes_the_first(monkeypatch, tmp_path, clean_capture):
    FakeUpstream().install(monkeypatch)
    first = await manager.create(
        "capture-one", _profile(), 1, runs_dir=tmp_path, capture_all=True
    )
    second = await manager.create(
        "capture-two", _profile(), 1, runs_dir=tmp_path, capture_all=True
    )
    assert manager.capture_run is second
    # The first was finished (scorecard persisted) when the second started.
    assert (tmp_path / "capture-one.scorecard.json").exists()
    assert any(e.event == "run_finished" for e in first.events)
    await second.finish()
    assert manager.capture_run is None


async def test_finish_clears_capture(monkeypatch, tmp_path, clean_capture):
    FakeUpstream().install(monkeypatch)
    run = await manager.create(
        "capture-clear", _profile(), 1, runs_dir=tmp_path, capture_all=True
    )
    assert manager.capture_run is run
    await run.finish()
    assert manager.capture_run is None


async def test_capture_replay_parity(monkeypatch, tmp_path, clean_capture):
    """A captured headerless cohort re-scores from its JSONL identically."""
    FakeUpstream().install(monkeypatch)
    profile = _profile(
        {"type": "api_error", "probability": 0.4},
        {"type": "silent_lie", "probability": 0.5, "target_tools": ["weather"]},
        seed=42,
        name="capture",
    )
    run = await manager.create(
        "capture-parity", profile, 2, runs_dir=tmp_path, capture_all=True
    )
    for _conversation in range(2):
        raw, parsed = _chat(_start_messages())
        session = run.session(run.capture_agent_id(parsed))
        await inject.inject_chat_completion(
            run, session, raw_body=raw, parsed=parsed, headers={}
        )
        for _turn in range(5):
            raw, parsed = _chat(_basic_messages())
            session = run.session(run.capture_agent_id(parsed))
            await inject.inject_chat_completion(
                run, session, raw_body=raw, parsed=parsed, headers={}
            )
    assert set(run.sessions) == {0, 1}
    await run.finish()

    persisted = Scorecard.model_validate_json(
        (tmp_path / "capture-parity.scorecard.json").read_text()
    )
    rescored = score(
        read_jsonl(tmp_path / "capture-parity.jsonl"),
        [],
        run_id="capture-parity",
        profile=profile.name,
    )
    assert rescored.model_dump() == persisted.model_dump()


def test_capture_status_endpoint(http_env, clean_capture):
    from starlette.testclient import TestClient

    from saboteur.api import app

    with TestClient(app) as client:
        assert client.get("/proxy/capture").json() == {"run_id": None}
        started = client.post(
            "/proxy/runs", json={"profile": "calm_seas", "n_agents": 1, "capture_all": True}
        )
        run_id = started.json()["run_id"]
        assert client.get("/proxy/capture").json() == {"run_id": run_id}
        client.post(f"/proxy/runs/{run_id}/finish")
        assert client.get("/proxy/capture").json() == {"run_id": None}


# ---------------------------------------------------------------------------
# HTTP layer (router wiring) via TestClient
# ---------------------------------------------------------------------------


@pytest.fixture()
def http_env(monkeypatch, tmp_path):
    """Stub the upstream and redirect run artifacts to a temp dir."""
    import saboteur.api.runs as runs_mod
    import saboteur.proxy.router as router_mod

    fake = FakeUpstream().install(monkeypatch)
    monkeypatch.setattr(router_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(runs_mod, "_RUNS_DIR", tmp_path)
    return fake


def test_http_passthrough_no_run_header(http_env):
    from starlette.testclient import TestClient

    from saboteur.api import app

    raw, _ = _chat(_basic_messages())
    with TestClient(app) as client:
        resp = client.post("/v1/chat/completions", content=raw)

    assert resp.status_code == 200
    assert resp.content == _CANNED_BYTES  # transparent passthrough
    assert http_env.bodies == [raw]


def test_http_run_lifecycle_and_scorecard(http_env):
    from starlette.testclient import TestClient

    from saboteur.api import app

    raw, _ = _chat(_basic_messages())
    with TestClient(app) as client:
        started = client.post("/proxy/runs", json={"profile": "calm_seas", "n_agents": 1})
        assert started.status_code == 202
        run_id = started.json()["run_id"]

        headers = {"X-Saboteur-Run-Id": run_id, "X-Saboteur-Agent-Id": "0"}
        resp = client.post("/v1/chat/completions", content=raw, headers=headers)
        assert resp.status_code == 200

        listing = client.get("/runs").json()
        assert any(e["run_id"] == run_id for e in listing)

        finished = client.post(f"/proxy/runs/{run_id}/finish")
        assert finished.status_code == 200

        scorecard = client.get(f"/runs/{run_id}/scorecard")
        assert scorecard.status_code == 200
        body = scorecard.json()
        assert body["survival_rate"] is None
        assert body["survival_rate_reason"] == "no_oracle"
