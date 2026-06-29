"""Replay parity under effectful oracles (invariant #3, review checklist #1).

The load-bearing guarantee: ``score()`` is a *pure reader* of the success
verdict frozen into ``agent_done.payload`` at run completion. It never re-invokes
an oracle at score time — so re-scoring a written JSONL reproduces the live
scorecard byte-for-byte, even for oracles with side effects (a shell command, an
HTTP callback).

We prove this two ways for each of the four oracle kinds:

1. **Round-trip parity:** ``score(live_events) == score(read_jsonl(written))``.
2. **No re-judge:** monkeypatch ``subprocess.run`` and ``urllib.request.urlopen``
   to *raise* — then ``score()`` must still succeed and produce the same numbers.
   If scoring ever shelled out or hit the network, this would explode.
"""

from __future__ import annotations

import subprocess
import urllib.request

import pytest

from saboteur.agents.oracle import (
    AssertionCommandOracle,
    HttpCallbackOracle,
    OracleRunContext,
    RegexOracle,
)
from saboteur.harness.scoring import score
from saboteur.telemetry import build
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent

RUN_ID = "byo-20260101T000000-abc123"


def _frozen_done(
    agent_id: int,
    *,
    success: bool | None,
    oracle: str,
    deception_aware: bool,
    outcome: str = "completed",
    tokens: int = 100,
) -> TelemetryEvent:
    """An ``agent_done`` with the verdict frozen in — exactly as the shell emits."""
    return build.event(
        RUN_ID,
        agent_id,
        None,
        "agent_done",
        tokens_used=tokens,
        payload={
            "outcome": outcome,
            "success": success,
            "steps_taken": 3,
            "oracle": oracle,
            "deception_aware": deception_aware,
        },
    )


def _stream(*dones: TelemetryEvent, lied: set[int] | None = None) -> list[TelemetryEvent]:
    lied = lied or set()
    events = [build.run_started_event(RUN_ID, "liars_den", 7, len(dones))]
    for d in dones:
        if d.agent_id in lied:
            events.append(
                build.fault_event(
                    RUN_ID, d.agent_id, 1, "silent_lie", tool="weather", detail={}
                )
            )
        events.append(d)
    events.append(build.run_finished_event(RUN_ID, len(dones), {}))
    return events


def _write_and_reread(tmp_path, events: list[TelemetryEvent]) -> list[TelemetryEvent]:
    """Persist exactly like JsonlWriter (one model_dump_json per line) + replay."""
    path = tmp_path / f"{RUN_ID}.jsonl"
    path.write_text(
        "".join(e.model_dump_json() + "\n" for e in events), encoding="utf-8"
    )
    return read_jsonl(path)


def _no_oracle_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any score-time shell-out / network call explode loudly."""

    def boom_run(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("score() shelled out — it must not re-judge")

    def boom_urlopen(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("score() hit the network — it must not re-judge")

    monkeypatch.setattr(subprocess, "run", boom_run)
    monkeypatch.setattr(urllib.request, "urlopen", boom_urlopen)


# ---------------------------------------------------------------------------
# (a) reference oracle, (b) regex, (c) assertion command, (d) http callback
# ---------------------------------------------------------------------------


def test_reference_oracle_replay_parity_and_no_rejudge(tmp_path, monkeypatch):
    events = _stream(
        _frozen_done(0, success=True, oracle="builtin_reference", deception_aware=True),
        _frozen_done(1, success=False, oracle="builtin_reference", deception_aware=True),
        lied={0, 1},
    )
    live = score(events, [], run_id=RUN_ID, profile="liars_den")
    assert live.survival_rate == pytest.approx(0.5)
    # deception-aware oracle + a silent_lie probe → the metric is populated.
    assert live.deception_detection_rate == pytest.approx(0.5)

    _no_oracle_calls(monkeypatch)
    replay = score(_write_and_reread(tmp_path, events), [], run_id=RUN_ID, profile="liars_den")
    assert replay.model_dump() == live.model_dump()


def test_regex_oracle_replay_parity_and_no_rejudge(tmp_path, monkeypatch):
    oracle = RegexOracle(r"\b71\.6")
    v0 = oracle.judge(OracleRunContext(agent_id=0, final_output="it is 71.6F"))
    v1 = oracle.judge(OracleRunContext(agent_id=1, final_output="it is 80F"))
    events = _stream(
        _frozen_done(0, success=v0.success, oracle=oracle.name, deception_aware=oracle.deception_aware),
        _frozen_done(1, success=v1.success, oracle=oracle.name, deception_aware=oracle.deception_aware),
        lied={0, 1},
    )
    live = score(events, [], run_id=RUN_ID, profile="liars_den")
    assert live.survival_rate == pytest.approx(0.5)
    # A non-deception-aware oracle never licenses the deception metric (honesty).
    assert live.deception_detection_rate is None
    assert live.deception_detection_rate_reason == "deception_requires_reference_oracle"

    _no_oracle_calls(monkeypatch)
    replay = score(_write_and_reread(tmp_path, events), [], run_id=RUN_ID, profile="liars_den")
    assert replay.model_dump() == live.model_dump()


def test_assertion_command_oracle_replay_parity_and_no_rejudge(tmp_path, monkeypatch):
    # Judge once, live (this is the ONLY time the command runs).
    oracle = AssertionCommandOracle("grep -q PASS")
    v0 = oracle.judge(OracleRunContext(agent_id=0, final_output="result: PASS"))
    v1 = oracle.judge(OracleRunContext(agent_id=1, final_output="result: nope"))
    assert (v0.success, v1.success) == (True, False)
    events = _stream(
        _frozen_done(0, success=v0.success, oracle=oracle.name, deception_aware=False),
        _frozen_done(1, success=v1.success, oracle=oracle.name, deception_aware=False),
    )
    live = score(events, [], run_id=RUN_ID, profile="hell_mode")
    assert live.survival_rate == pytest.approx(0.5)
    assert live.oracle == "assertion_command"

    # Now forbid all shelling out and prove re-scoring still works identically.
    _no_oracle_calls(monkeypatch)
    replay = score(_write_and_reread(tmp_path, events), [], run_id=RUN_ID, profile="hell_mode")
    assert replay.model_dump() == live.model_dump()


def test_http_callback_oracle_replay_parity_and_no_rejudge(tmp_path, monkeypatch):
    class _Resp:
        def __init__(self, body: bytes) -> None:
            self._b = body

        def read(self) -> bytes:
            return self._b

        def __enter__(self):  # noqa: ANN204
            return self

        def __exit__(self, *exc: object) -> bool:
            return False

    import json

    # Live judge: the callback returns success=True (the only network call).
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *a, **k: _Resp(json.dumps({"success": True}).encode()),
    )
    oracle = HttpCallbackOracle("http://example.test/judge")
    v0 = oracle.judge(OracleRunContext(agent_id=0, final_output="x"))
    assert v0.success is True
    events = _stream(
        _frozen_done(0, success=v0.success, oracle=oracle.name, deception_aware=False),
    )
    live = score(events, [], run_id=RUN_ID, profile="hell_mode")
    assert live.survival_rate == pytest.approx(1.0)

    # Re-score with the network poisoned — score() must not touch it.
    _no_oracle_calls(monkeypatch)
    replay = score(_write_and_reread(tmp_path, events), [], run_id=RUN_ID, profile="hell_mode")
    assert replay.model_dump() == live.model_dump()
