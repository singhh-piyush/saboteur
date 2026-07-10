"""MCP shim tests — offline, with a stubbed/trivial upstream.

Two layers, mirroring ``test_proxy.py``:

- the fault pipeline (``saboteur.mcp.inject``) driven in-process with a fake
  ``upstream_call`` + a list sink — transparency, every fault @ p=1.0,
  determinism/isolation, recovery classification, replay parity;
- the HTTP ingest (``/mcp/*``) via ``TestClient``;
- one real end-to-end stdio exchange: a spawned shim wrapping the trivial
  ``examples/mcp_min_server`` server, driven over stdio with raw JSON-RPC.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from saboteur.chaos.profile import ChaosProfile, FaultSpec
from saboteur.harness.scoring import Scorecard, score
from saboteur.mcp import inject
from saboteur.mcp.telemetry import ListEmitter
from saboteur.proxy.session import ProxySession, manager
from saboteur.telemetry.jsonl import read_jsonl

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MIN_SERVER = _REPO_ROOT / "examples" / "mcp_min_server" / "server.py"
_READING = "22.0°C (71.6°F)"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _profile(*faults: dict[str, Any], seed: int = 7, name: str = "probe") -> ChaosProfile:
    return ChaosProfile(name=name, seed=seed, faults=[FaultSpec(**f) for f in faults])


def _session(profile: ChaosProfile, agent_id: int = 0) -> ProxySession:
    return ProxySession("mcp-test", agent_id, profile)


def _upstream_result(text: str = _READING) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": False}


class FakeUpstream:
    # Returns a canned tool result; counts calls (to prove non-forwarding).

    def __init__(self, text: str = _READING) -> None:
        self.text = text
        self.calls = 0

    async def __call__(self, params: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        return _upstream_result(self.text)


async def _call(
    session: ProxySession,
    emitter: ListEmitter,
    *,
    name: str = "get_weather",
    args: dict[str, Any] | None = None,
    jid: int = 1,
    upstream: FakeUpstream | None = None,
) -> dict[str, Any]:
    up = upstream or FakeUpstream()
    return await inject.handle_tools_call(
        session,
        run_id="mcp-test",
        params={"name": name, "arguments": args or {"city": "Tokyo"}},
        jsonrpc_id=jid,
        emit=emitter.emit,
        upstream_call=up,
    )


def _faults(emitter: ListEmitter) -> list[str | None]:
    return [e.fault for e in emitter.events if e.event == "fault_injected"]


def _result_text(envelope: dict[str, Any]) -> str:
    return envelope["result"]["content"][0]["text"]


# ---------------------------------------------------------------------------
# Transparency
# ---------------------------------------------------------------------------


async def test_passthrough_calm_seas_unchanged():
    emitter = ListEmitter()
    up = FakeUpstream()
    env = await _call(_session(_profile()), emitter, upstream=up)

    assert env["result"] == _upstream_result()
    assert env["jsonrpc"] == "2.0" and env["id"] == 1
    assert _faults(emitter) == []
    assert up.calls == 1

    tc = [e for e in emitter.events if e.event == "tool_call"][0]
    assert tc.payload["sabotaged"] is False and tc.payload["errored"] is False


# ---------------------------------------------------------------------------
# Each fault at probability 1.0
# ---------------------------------------------------------------------------


async def test_latency_sleeps_then_forwards(monkeypatch):
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr(inject.asyncio, "sleep", fake_sleep)
    emitter = ListEmitter()
    up = FakeUpstream()
    env = await _call(
        _session(_profile({"type": "latency", "probability": 1.0, "delay_s": [0.5, 1.0]})),
        emitter,
        upstream=up,
    )

    assert slept and slept[0] >= 0.5
    assert env["result"] == _upstream_result()
    assert up.calls == 1
    assert "latency" in _faults(emitter)


async def test_rate_limit_returns_error_without_forwarding():
    emitter = ListEmitter()
    up = FakeUpstream()
    env = await _call(
        _session(_profile({"type": "rate_limit", "probability": 1.0, "retry_after_s": [2.0, 4.0]})),
        emitter,
        upstream=up,
    )

    assert env["result"]["isError"] is True
    assert "Retry after" in _result_text(env)
    assert up.calls == 0
    assert "rate_limit" in _faults(emitter)


async def test_tool_vanish_errors_and_is_sticky():
    emitter = ListEmitter()
    up = FakeUpstream()
    session = _session(
        _profile({"type": "tool_vanish", "probability": 1.0, "target_tools": ["get_weather"]})
    )

    env1 = await _call(session, emitter, jid=1, upstream=up)
    assert env1["result"]["isError"] is True
    assert "not found" in _result_text(env1)
    assert "tool_vanish" in _faults(emitter)
    assert session.vanish is not None and session.vanish.is_vanished("get_weather")
    assert up.calls == 0


    env2 = await _call(session, emitter, jid=2, upstream=up)
    assert env2["result"]["isError"] is True
    sticky = [e for e in emitter.events if e.fault == "tool_vanish"][-1]
    assert sticky.payload["detail"] == {"sticky": True}


    listed = inject.handle_tools_list(
        session, {"tools": [{"name": "get_weather"}, {"name": "add"}]}
    )
    names = [t["name"] for t in listed["tools"]]
    assert "get_weather" not in names and "add" in names


async def test_malformed_truncates_result_text():
    emitter = ListEmitter()
    env = await _call(
        _session(_profile({"type": "malformed", "probability": 1.0})), emitter
    )

    text = _result_text(env)
    assert len(text) < len(_READING)
    # The MCP result still claims success (isError False) — malformed is garbage
    # content that *looks* normal; the sabotage is visible only in telemetry.
    assert env["result"]["isError"] is False
    assert "malformed" in _faults(emitter)
    tc = [e for e in emitter.events if e.event == "tool_call"][0]
    assert tc.payload["errored"] is True


async def test_silent_lie_perturbs_last_number_only():
    emitter = ListEmitter()
    env = await _call(
        _session(
            _profile({"type": "silent_lie", "probability": 1.0, "target_tools": ["get_weather"]})
        ),
        emitter,
    )

    text = _result_text(env)
    assert text != _READING
    assert "22.0" in text
    assert env["result"]["isError"] is False
    assert "silent_lie" in _faults(emitter)


# ---------------------------------------------------------------------------
# Determinism + isolation
# ---------------------------------------------------------------------------


async def test_determinism_same_seed_same_fault_sequence():
    spec = {"type": "rate_limit", "probability": 0.5, "retry_after_s": [1.0, 2.0]}

    async def run_once() -> list[str | None]:
        emitter = ListEmitter()
        session = _session(_profile(spec, seed=1337), agent_id=3)
        for i in range(20):
            await _call(session, emitter, jid=i)
        return _faults(emitter)

    first = await run_once()
    second = await run_once()
    assert first == second
    assert first


async def test_isolation_vanish_state_per_session():
    profile = _profile(
        {"type": "tool_vanish", "probability": 1.0, "target_tools": ["get_weather"]}
    )
    sess0, sess1 = _session(profile, 0), _session(profile, 1)
    await _call(sess0, ListEmitter())

    assert sess0.vanish is not None and sess0.vanish.is_vanished("get_weather")
    assert sess1.vanish is not None and not sess1.vanish.is_vanished("get_weather")


# ---------------------------------------------------------------------------
# Recovery classification over the call stream
# ---------------------------------------------------------------------------


async def test_recovery_retry_reformulate_fallback():
    emitter = ListEmitter()
    # Every call rate-limits, so each call after the first is a reaction.
    session = _session(_profile({"type": "rate_limit", "probability": 1.0, "retry_after_s": [1.0, 2.0]}))

    seq = [
        ("get_weather", {"city": "Tokyo"}),
        ("get_weather", {"city": "Tokyo"}),
        ("get_weather", {"city": "Kyoto"}),
        ("add", {"a": 1, "b": 2}),
    ]
    for i, (name, args) in enumerate(seq):
        await _call(session, emitter, name=name, args=args, jid=i)

    recoveries = [e.recovery for e in emitter.events if e.event == "recovery_action"]
    assert recoveries == ["retry", "reformulate", "fallback_tool"]


# ---------------------------------------------------------------------------
# Replay parity (real bus + JSONL writer via the manager)
# ---------------------------------------------------------------------------


async def test_replay_parity_rescore_equals_persisted(tmp_path):
    profile = _profile(
        {"type": "rate_limit", "probability": 0.4, "retry_after_s": [1.0, 2.0]},
        {"type": "silent_lie", "probability": 0.5, "target_tools": ["get_weather"]},
        seed=99,
    )
    run = await manager.create("mcp-replay-test", profile, 2, runs_dir=tmp_path)
    for agent_id in (0, 1):
        session = run.session(agent_id)
        for i in range(6):
            await inject.handle_tools_call(
                session,
                run_id=run.run_id,
                params={"name": "get_weather", "arguments": {"city": "Tokyo"}},
                jsonrpc_id=i,
                emit=run.emit,
                upstream_call=FakeUpstream(),
            )
    await run.finish()

    persisted = Scorecard.model_validate_json(
        (tmp_path / "mcp-replay-test.scorecard.json").read_text()
    )
    rescored = score(
        read_jsonl(tmp_path / "mcp-replay-test.jsonl"),
        [],
        run_id="mcp-replay-test",
        profile=profile.name,
    )
    assert rescored.model_dump() == persisted.model_dump()
    assert persisted.survival_rate is None
    assert persisted.survival_rate_reason == "no_oracle"
    assert persisted.n_agents == 2


# ---------------------------------------------------------------------------
# HTTP ingest layer (router wiring) via TestClient
# ---------------------------------------------------------------------------


@pytest.fixture()
def http_env(monkeypatch, tmp_path):
    import saboteur.api.runs as runs_mod
    import saboteur.mcp.router as router_mod

    monkeypatch.setattr(router_mod, "_RUNS_DIR", tmp_path)
    monkeypatch.setattr(runs_mod, "_RUNS_DIR", tmp_path)
    return tmp_path


def test_http_run_ingest_and_scorecard(http_env):
    from starlette.testclient import TestClient

    from saboteur.api import app
    from saboteur.telemetry import build

    with TestClient(app) as client:
        started = client.post("/mcp/runs", json={"profile": "calm_seas", "n_agents": 1})
        assert started.status_code == 202
        run_id = started.json()["run_id"]

        ev = build.tool_call_event(
            run_id, 0, 1, "get_weather", {"city": "Tokyo"},
            sabotaged=True, fault_types=["silent_lie"], errored=False,
        )
        resp = client.post(f"/mcp/runs/{run_id}/events", json=ev.model_dump(mode="json"))
        assert resp.status_code == 202


        run = manager.get(run_id)
        assert any(e.event == "tool_call" for e in run.events)
        assert len(run.session(0).history) == 1

        finished = client.post(f"/mcp/runs/{run_id}/finish")
        assert finished.status_code == 200

        scorecard = client.get(f"/runs/{run_id}/scorecard")
        assert scorecard.status_code == 200
        assert scorecard.json()["survival_rate"] is None
        assert any(e["run_id"] == run_id for e in client.get("/runs").json())


def test_http_ingest_unknown_run_404(http_env):
    from starlette.testclient import TestClient

    from saboteur.api import app
    from saboteur.telemetry import build

    ev = build.step_start_event("nope", 0, 1)
    with TestClient(app) as client:
        resp = client.post("/mcp/runs/nope/events", json=ev.model_dump(mode="json"))
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# End-to-end stdio: real shim subprocess wrapping the trivial upstream
# ---------------------------------------------------------------------------


def _shim_exchange(profile_arg: str, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Spawn the shim wrapping the trivial server; exchange JSON-RPC over stdio."""
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "saboteur.mcp",
            "--profile", profile_arg,
            "--", sys.executable, str(_MIN_SERVER),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        cwd=str(_REPO_ROOT),
    )
    inp = "".join(json.dumps(r) + "\n" for r in requests)
    out, _ = proc.communicate(input=inp, timeout=30)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


_INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
_INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def _weather_call(jid: int) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0", "id": jid, "method": "tools/call",
        "params": {"name": "get_weather", "arguments": {"city": "Tokyo"}},
    }


def test_e2e_stdio_calm_seas_passthrough():
    responses = _shim_exchange("calm_seas", [_INIT, _INITED, _weather_call(2)])
    by_id = {r["id"]: r for r in responses}
    assert by_id[1]["result"]["serverInfo"]["name"] == "mcp-min"
    assert by_id[2]["result"]["content"][0]["text"] == _READING


def test_e2e_stdio_silent_lie_corrupts(tmp_path):
    profile = tmp_path / "lie.yaml"
    profile.write_text(
        "name: lie_e2e\nseed: 1\nfaults:\n"
        "  - type: silent_lie\n    probability: 1.0\n    target_tools: [get_weather]\n"
    )
    responses = _shim_exchange(str(profile), [_INIT, _INITED, _weather_call(2)])
    by_id = {r["id"]: r for r in responses}
    text = by_id[2]["result"]["content"][0]["text"]
    assert text != _READING and "22.0" in text
