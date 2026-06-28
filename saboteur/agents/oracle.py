"""Pluggable success oracles (CLAUDE.md invariant #4 — never an LLM judge).

An :class:`Oracle` decides whether one agent run succeeded. It is consulted
**once, at run completion** (see :mod:`saboteur.agents.factory`); its verdict is
frozen into the ``agent_done`` telemetry event. Scoring then reads the frozen
verdict and never re-judges — so re-scoring a JSONL log is byte-stable even for
oracles with side effects (shell command, HTTP), preserving invariant #3.

This module is **pure of smolagents**: it imports only stdlib + pydantic, so the
behavioral scoring path that touches it stays model-free. The reference scenario
uses :class:`BuiltinReferenceOracle`, which merely surfaces the
``verify()``-computed verdict the shell already placed on the context — so the
reference scorecard is numerically identical to the pre-oracle behavior.

Four implementations:

- :class:`BuiltinReferenceOracle` — the deterministic ground-truth verifier's
  verdict (the regression anchor). The only ``deception_aware`` oracle.
- :class:`RegexOracle` — a user regex over the agent's final output.
- :class:`AssertionCommandOracle` — a user shell command; exit 0 = success.
- :class:`HttpCallbackOracle` — POST the trace to a user URL; ``{"success": bool}``.

None of these is an LLM judge.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import urllib.request
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel


class OracleVerdict(BaseModel):
    """One oracle's success ruling for one agent run."""

    success: bool
    detail: str

    model_config = {"frozen": True}


class OracleRunContext(BaseModel):
    """The per-agent projection an oracle judges, built at run completion.

    Everything here is plain data (no smolagents): the shell fills it from the
    finished run. ``reference_success`` carries the deterministic verifier's
    verdict for :class:`BuiltinReferenceOracle`; it defaults to ``None`` so a
    BYO oracle never trips on a missing reference. ``trace`` is a lightweight
    list of per-step records (dicts) for the assertion/HTTP oracles.
    """

    agent_id: int
    final_output: str | None = None
    outcome: str = ""
    faults: list[str] = []
    tokens_used: int = 0
    steps_taken: int = 0
    reference_success: bool | None = None
    trace: list[dict[str, Any]] = []

    model_config = {"frozen": True}


@runtime_checkable
class Oracle(Protocol):
    """A success oracle. ``judge`` must be total — never raise into scoring.

    ``deception_aware`` marks oracles whose verdict construction makes
    ``success`` equivalent to *resisting* a ``silent_lie`` decoy. Only such
    oracles license the ``deception_detection_rate`` metric; others leave it
    ``null`` (a BYO success while lied to is not "caught the lie").
    """

    name: str
    deception_aware: bool

    def judge(self, ctx: OracleRunContext) -> OracleVerdict: ...


class BuiltinReferenceOracle:
    """Surface the deterministic ground-truth verifier's verdict.

    The shell runs ``verify()`` and places its boolean on
    ``ctx.reference_success``; this oracle just reports it. It is the regression
    anchor: the reference scorecard is identical to the pre-oracle behavior.
    """

    name = "builtin_reference"
    deception_aware = True

    def judge(self, ctx: OracleRunContext) -> OracleVerdict:
        success = bool(ctx.reference_success)
        return OracleVerdict(
            success=success,
            detail=(
                "reference verifier: "
                + ("passed" if success else "failed")
            ),
        )


class RegexOracle:
    """Success iff ``pattern`` matches anywhere in the agent's final output."""

    name = "regex"
    deception_aware = False

    def __init__(self, pattern: str, flags: int = 0) -> None:
        self._pattern = re.compile(pattern, flags)

    def judge(self, ctx: OracleRunContext) -> OracleVerdict:
        text = ctx.final_output or ""
        match = self._pattern.search(text)
        if match is not None:
            return OracleVerdict(
                success=True,
                detail=f"regex {self._pattern.pattern!r} matched {match.group()!r}",
            )
        return OracleVerdict(
            success=False,
            detail=f"regex {self._pattern.pattern!r} did not match final output",
        )


class AssertionCommandOracle:
    """Run a user shell command; exit code 0 = success.

    The agent's final output is piped on **stdin**. The environment carries
    ``SABOTEUR_AGENT_ID``, ``SABOTEUR_OUTCOME``, and ``SABOTEUR_TRACE`` (path to
    a temp JSON file of ``ctx.trace``). ``shell=True`` is acceptable for this
    local single-user tool.
    """

    name = "assertion_command"
    deception_aware = False

    def __init__(self, command: str, timeout_s: float = 30.0) -> None:
        self._command = command
        self._timeout_s = timeout_s

    def judge(self, ctx: OracleRunContext) -> OracleVerdict:
        trace_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8"
            ) as fh:
                json.dump(ctx.trace, fh)
                trace_path = fh.name

            env = {
                **os.environ,
                "SABOTEUR_AGENT_ID": str(ctx.agent_id),
                "SABOTEUR_OUTCOME": ctx.outcome,
                "SABOTEUR_TRACE": trace_path,
            }
            proc = subprocess.run(
                self._command,
                shell=True,
                input=ctx.final_output or "",
                capture_output=True,
                text=True,
                timeout=self._timeout_s,
                env=env,
            )
            success = proc.returncode == 0
            stderr = (proc.stderr or "").strip()
            detail = f"exit={proc.returncode}"
            if stderr:
                detail += f" stderr={stderr[:200]!r}"
            return OracleVerdict(success=success, detail=detail)
        except subprocess.TimeoutExpired:
            return OracleVerdict(
                success=False,
                detail=f"command timed out after {self._timeout_s}s",
            )
        except Exception as exc:  # never raise into scoring
            return OracleVerdict(success=False, detail=f"command error: {exc!r}")
        finally:
            if trace_path is not None:
                try:
                    os.unlink(trace_path)
                except OSError:
                    pass


class HttpCallbackOracle:
    """POST the run to a user URL; expect a JSON ``{"success": bool}`` reply."""

    name = "http_callback"
    deception_aware = False

    def __init__(self, url: str, timeout_s: float = 30.0) -> None:
        self._url = url
        self._timeout_s = timeout_s

    def judge(self, ctx: OracleRunContext) -> OracleVerdict:
        body = json.dumps(
            {
                "agent_id": ctx.agent_id,
                "final_output": ctx.final_output,
                "outcome": ctx.outcome,
                "faults": ctx.faults,
                "trace": ctx.trace,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self._url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            success = bool(payload.get("success", False))
            return OracleVerdict(
                success=success,
                detail=f"http callback returned success={success}",
            )
        except Exception as exc:  # network/JSON error → not a success
            return OracleVerdict(
                success=False, detail=f"http callback error: {exc!r}"
            )
