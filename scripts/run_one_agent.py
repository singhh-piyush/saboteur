#!/usr/bin/env python
# Usage: .venv/bin/python scripts/run_one_agent.py [profile]

from __future__ import annotations

import asyncio
import sys
import urllib.error
import urllib.parse
import urllib.request

from saboteur.agents import AgentEvent, build_agent
from saboteur.chaos import load_profile
from saboteur.config import get_settings


def _server_is_up(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url}/models", timeout=2) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _print_event(event: AgentEvent) -> None:
    step = "--" if event.step is None else f"{event.step:>2}"
    print(f"[step {step}] {event.kind:<11} {event.data}")


async def _main(profile_path: str) -> int:
    settings = get_settings()
    if not _server_is_up(settings.openai_base_url):
        host = urllib.parse.urlparse(settings.openai_base_url).hostname
        if host in ("localhost", "127.0.0.1"):
            hint = (
                "Start it first, e.g.:\n"
                "  bash scripts/run_local.sh        # idempotent: starts it + uvicorn\n"
                "or directly (note --jinja is REQUIRED for tool calling):\n"
                "  llama-server -m \"$MODEL_GGUF\" --port 8080 -c 32768 -np 8 --jinja\n"
            )
        else:
            hint = (
                "Check that the remote endpoint is up and reachable (e.g. the SSH "
                "tunnel to it is still open).\n"
            )
        print(
            f"inference server is not reachable at {settings.openai_base_url}.\n"
            f"{hint}",
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
