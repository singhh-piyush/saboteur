#!/usr/bin/env python
"""Run ONE Saboteur agent end-to-end against flaky_friday (needs a live LLM).

This is the WP4 acceptance harness. It builds a single sabotaged agent, runs
it under the local llama.cpp server, streams every telemetry event to stdout,
then prints the classified terminal outcome and the programmatic verifier's
verdict.

Prereq: ``llama-server`` running on :8080 **with --jinja** (so the chat
template emits OpenAI-style tool calls). Start it via ``scripts/run_local.sh``
or directly. If tool calls come back malformed/garbage, the first thing to
check is that ``--jinja`` was passed — before suspecting this code.

Usage::

    .venv/bin/python scripts/run_one_agent.py
    .venv/bin/python scripts/run_one_agent.py profiles/hell_mode.yaml
"""

from __future__ import annotations

import asyncio
import sys
import urllib.error
import urllib.request

from saboteur.agents import AgentEvent, build_agent
from saboteur.chaos import load_profile
from saboteur.config import get_settings

_HEALTH_URL = "http://localhost:8080/health"


def _server_is_up() -> bool:
    try:
        with urllib.request.urlopen(_HEALTH_URL, timeout=2) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _print_event(event: AgentEvent) -> None:
    step = "--" if event.step is None else f"{event.step:>2}"
    print(f"[step {step}] {event.kind:<11} {event.data}")


async def _main(profile_path: str) -> int:
    settings = get_settings()
    if not _server_is_up():
        print(
            "llama-server is not reachable at http://localhost:8080.\n"
            "Start it first, e.g.:\n"
            "  bash scripts/run_local.sh        # idempotent: starts it + uvicorn\n"
            "or directly (note --jinja is REQUIRED for tool calling):\n"
            "  llama-server -m \"$MODEL_GGUF\" --port 8080 -c 32768 -np 8 --jinja\n",
            file=sys.stderr,
        )
        return 1

    profile = load_profile(profile_path)
    print(f"profile={profile.name} seed={profile.seed} "
          f"model={settings.model_id} max_steps={settings.max_steps}\n")

    store: dict = {}
    agent = build_agent(0, profile, store, on_event=_print_event)
    result = await agent.run()

    print("\n" + "=" * 60)
    print(f"outcome        : {result.outcome}")
    print(f"steps taken    : {result.steps_taken} (cap {settings.max_steps})")
    print(f"tokens used    : {result.tokens_used}")
    print(f"faults injected: {len(result.faults)}")
    print(f"recoveries     : {[str(r.kind) for r in result.recoveries]}")
    if result.task_result is not None:
        tr = result.task_result
        print(f"verifier       : success={tr.success} reason={tr.failure_reason} "
              f"value={tr.found_value}")
        print(f"                 {tr.detail}")
    if result.error:
        print(f"error          : {result.error}")
    print("=" * 60)

    if result.steps_taken > settings.max_steps:
        print("WARNING: step cap exceeded — bounded-run invariant violated.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "profiles/flaky_friday.yaml"
    raise SystemExit(asyncio.run(_main(path)))
