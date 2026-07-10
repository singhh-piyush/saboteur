"""Pluggable success oracles.

An Oracle decides whether an agent run succeeded. It is consulted once at run completion, and the verdict is frozen into telemetry.

Four implementations:
- BuiltinReferenceOracle: deterministic ground-truth verifier verdict (the regression anchor)
- RegexOracle: user regex over the agent's final output
- AssertionCommandOracle: user shell command (exit 0 is success)
- HttpCallbackOracle: POST the trace to a user URL
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
    # one oracle's success ruling for one agent run

    success: bool
    detail: str

    model_config = {"frozen": True}


class OracleRunContext(BaseModel):
    # data object containing agent run results to be judged by an oracle

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
    """A success oracle. judge must never raise into scoring.

    deception_aware marks oracles where success requires resisting a silent_lie decoy.
    """

    name: str
    deception_aware: bool

    def judge(self, ctx: OracleRunContext) -> OracleVerdict: ...


class BuiltinReferenceOracle:
    # surfaces the deterministic ground-truth verifier verdict

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
    # success iff pattern matches anywhere in the agent's final output

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
    # runs a shell command (exit 0 = success) with final output on stdin

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
        except Exception as exc:  # handle error without raising
            return OracleVerdict(success=False, detail=f"command error: {exc!r}")
        finally:
            if trace_path is not None:
                try:
                    os.unlink(trace_path)
                except OSError:
                    pass


class HttpCallbackOracle:
    # POST the run to a user URL; expect a JSON {"success": bool} reply

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
        except Exception as exc:  # handle network or json errors
            return OracleVerdict(
                success=False, detail=f"http callback error: {exc!r}"
            )
