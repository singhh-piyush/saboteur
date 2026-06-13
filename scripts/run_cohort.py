#!/usr/bin/env python
"""Run a full cohort run locally (needs a live LLM) and print the scorecard.

This is the WP5 acceptance harness: a calm_seas control cohort followed by a
chaos cohort under the given profile, both at N agents, producing
``runs/{run_id}-control.jsonl``, ``runs/{run_id}.jsonl`` and
``runs/{run_id}.scorecard.json``.

Prereq: ``llama-server`` running on :8080 **with --jinja** (so the chat
template emits OpenAI-style tool calls). Start it via ``scripts/run_local.sh``
or directly. If tool calls come back malformed/garbage, the first thing to
check is that ``--jinja`` was passed — before suspecting this code.

Usage::

    .venv/bin/python scripts/run_cohort.py
    .venv/bin/python scripts/run_cohort.py profiles/hell_mode.yaml 8
"""

from __future__ import annotations

import asyncio
import sys
import urllib.error
import urllib.request
from pathlib import Path

from saboteur.config import get_settings
from saboteur.harness import orchestrate

_HEALTH_URL = "http://localhost:8080/health"
_RUNS_DIR = Path("runs")


def _server_is_up() -> bool:
    try:
        with urllib.request.urlopen(_HEALTH_URL, timeout=2) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _fmt(value: float | None, suffix: str = "") -> str:
    return "n/a" if value is None else f"{value:.2f}{suffix}"


async def _main(profile_path: str, n_agents: int | None) -> int:
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

    n = n_agents if n_agents is not None else settings.n_agents
    print(
        f"profile={profile_path} n_agents={n} model={settings.model_id} "
        f"concurrency_limit={settings.concurrency_limit}\n"
        "running control cohort (calm_seas) then chaos cohort...\n"
    )

    scorecard = await orchestrate(profile_path, n_agents=n)

    print("=" * 60)
    print(f"run_id                   : {scorecard.run_id}")
    print(f"profile                  : {scorecard.profile}")
    print(f"agents                   : {scorecard.n_agents}")
    print(f"survival rate            : {scorecard.survival_rate:.0%}")
    print(f"MTTR (steps)             : {_fmt(scorecard.mttr_steps)}")
    print(f"recovery breakdown       : {scorecard.recovery_breakdown}")
    print(f"waste factor             : {_fmt(scorecard.waste_factor, 'x')}")
    print(f"deception detection rate : {_fmt(scorecard.deception_detection_rate)}")
    print(f"failure modes            : {scorecard.failure_modes}")
    print("=" * 60)
    print("artifacts:")
    for name in (
        f"{scorecard.run_id}-control.jsonl",
        f"{scorecard.run_id}.jsonl",
        f"{scorecard.run_id}.scorecard.json",
    ):
        path = _RUNS_DIR / name
        status = "ok" if path.exists() else "MISSING"
        print(f"  [{status}] {path}")
    return 0


if __name__ == "__main__":
    profile = sys.argv[1] if len(sys.argv) > 1 else "profiles/flaky_friday.yaml"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else None
    raise SystemExit(asyncio.run(_main(profile, n)))
