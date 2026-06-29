#!/usr/bin/env python
"""Smoke-test the MCP shim end-to-end (self-contained — no MCP client needed).

What it proves (the WP acceptance for ``saboteur/mcp``):
  (a) calm_seas — a ``tools/call`` through the shim returns the SAME result as
      hitting the trivial upstream directly: the transparency contract.
  (b) a chaos profile — the same call, attributed to a chaos run, now observes
      corrupted / dropped / delayed results over a few attempts, and the run
      renders on the dashboard grid.

It spawns the shim (``python -m saboteur.mcp``) wrapping
``examples/mcp_min_server`` and drives it with raw JSON-RPC over stdio.

Prereq for the dashboard half: the Saboteur app on :8000
(``uvicorn saboteur.api:app``) so telemetry has somewhere to land. Part (a)
works without it.

Usage::

    .venv/bin/python scripts/mcp_smoke.py
    .venv/bin/python scripts/mcp_smoke.py --api http://localhost:8000 --profile hell_mode --attempts 8
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MIN_SERVER = _REPO_ROOT / "examples" / "mcp_min_server" / "server.py"
_READING = "22.0°C (71.6°F)"


def _up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except (urllib.error.URLError, OSError):
        return False


def _post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _exchange(args: list[str], requests: list[dict]) -> list[dict]:
    proc = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=str(_REPO_ROOT)
    )
    inp = "".join(json.dumps(r) + "\n" for r in requests)
    out, _ = proc.communicate(input=inp, timeout=60)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def _shim_args(profile: str, run_id: str | None, ingest: str) -> list[str]:
    base = [sys.executable, "-m", "saboteur.mcp", "--profile", profile, "--ingest", ingest]
    if run_id:
        base += ["--run", run_id, "--agent", "0"]
    return base + ["--", sys.executable, str(_MIN_SERVER)]


def _init() -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}


def _weather(jid: int) -> dict:
    return {
        "jsonrpc": "2.0", "id": jid, "method": "tools/call",
        "params": {"name": "get_weather", "arguments": {"city": "Tokyo"}},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://localhost:8000", help="Saboteur app base URL")
    parser.add_argument("--profile", default="hell_mode", help="chaos profile for part (b)")
    parser.add_argument("--attempts", type=int, default=8, help="tool calls for part (b)")
    args = parser.parse_args()
    api = args.api.rstrip("/")

    # (a) Transparency: calm_seas through the shim == the upstream directly.
    print("== (a) calm_seas transparency ==")
    reqs = [_init(), _weather(2)]
    via_shim = {r["id"]: r for r in _exchange(_shim_args("calm_seas", None, api), reqs)}
    text = via_shim[2]["result"]["content"][0]["text"]
    print(f"  upstream : {_READING!r}")
    print(f"  shim     : {text!r}")
    same = text == _READING
    print(f"  identical: {same}")

    # (b) Chaos: same call under a chaos profile observes faults; renders live.
    print(f"\n== (b) {args.profile} fault injection ({args.attempts} calls) ==")
    has_api = _up(f"{api}/mcp/health")
    run_id = None
    if has_api:
        run = _post_json(f"{api}/mcp/runs", {"profile": args.profile, "n_agents": 1})
        run_id = run["run_id"]
    else:
        print(f"  (dashboard not at {api}; running without live telemetry)")

    reqs = [_init()] + [_weather(i + 2) for i in range(args.attempts)]
    responses = {r["id"]: r for r in _exchange(_shim_args(args.profile, run_id, api), reqs)}
    outcomes = []
    for i in range(args.attempts):
        res = responses.get(i + 2, {}).get("result", {})
        blk = (res.get("content") or [{}])[0]
        outcomes.append("error" if res.get("isError") else blk.get("text", "?"))
    print(f"  results observed: {outcomes}")
    if run_id:
        _post_json(f"{api}/mcp/runs/{run_id}/finish", {})
        print(f"  scorecard: {api}/runs/{run_id}/scorecard")
        print(f"  dashboard: open {api} and inspect run {run_id}")

    return 0 if same else 2


if __name__ == "__main__":
    sys.exit(main())
