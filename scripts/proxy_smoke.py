#!/usr/bin/env python
# Usage: .venv/bin/python scripts/proxy_smoke.py [--api URL] [--profile NAME]

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request

from openai import OpenAI
from openai import APIError, APIStatusError

from saboteur.config import get_settings

_TASK = "In one short sentence, say hello and state today's plan."


def _up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except (urllib.error.URLError, OSError):
        return False


def _post_json(url: str, payload: dict) -> dict:
    import json

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _complete(client: OpenAI, model: str, headers: dict | None = None) -> str:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": _TASK}],
        temperature=0.0,
        seed=42,
        extra_headers=headers or {},
    )
    return resp.choices[0].message.content or ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://localhost:8000", help="Saboteur app base URL")
    parser.add_argument("--profile", default="hell_mode", help="chaos profile for part (b)")
    parser.add_argument("--attempts", type=int, default=8, help="requests for part (b)")
    args = parser.parse_args()

    settings = get_settings()
    upstream = settings.upstream_base_url
    proxy_v1 = f"{args.api.rstrip('/')}/v1"
    model = settings.model_id

    # llama-server's /health lives at the server root, above the /v1 mount.
    upstream_root = upstream.rstrip("/").removesuffix("/v1")
    if not _up(f"{upstream.rstrip('/')}/models") and not _up(f"{upstream_root}/health"):
        print(f"Upstream not reachable at {upstream}. Start scripts/run_local.sh first.")
        return 1
    if not _up(f"{args.api.rstrip('/')}/proxy/health"):
        print(f"Saboteur app not reachable at {args.api}. Start it (uvicorn saboteur.api:app).")
        return 1

    direct = OpenAI(base_url=upstream, api_key=settings.openai_api_key)
    via_proxy = OpenAI(base_url=proxy_v1, api_key=settings.openai_api_key)

    # (a) Transparency: calm_seas through the proxy == direct.
    print("== (a) calm_seas transparency ==")
    run = _post_json(f"{args.api.rstrip('/')}/proxy/runs", {"profile": "calm_seas", "n_agents": 1})
    run_id = run["run_id"]
    hdrs = {"X-Saboteur-Run-Id": run_id, "X-Saboteur-Agent-Id": "0"}
    direct_out = _complete(direct, model)
    proxy_out = _complete(via_proxy, model, hdrs)
    _post_json(f"{args.api.rstrip('/')}/runs/{run_id}/cancel", {})
    same = direct_out.strip() == proxy_out.strip()
    print(f"  direct : {direct_out[:80]!r}")
    print(f"  proxy  : {proxy_out[:80]!r}")
    print(f"  identical content: {same}")

    # (b) Chaos: same request under a chaos profile observes faults.
    print(f"\n== (b) {args.profile} fault injection ({args.attempts} attempts) ==")
    run = _post_json(
        f"{args.api.rstrip('/')}/proxy/runs", {"profile": args.profile, "n_agents": 1}
    )
    run_id = run["run_id"]
    hdrs = {"X-Saboteur-Run-Id": run_id, "X-Saboteur-Agent-Id": "0"}
    statuses: list[str] = []
    for _ in range(args.attempts):
        try:
            _complete(via_proxy, model, hdrs)
            statuses.append("200")
        except APIStatusError as exc:
            statuses.append(str(exc.status_code))
        except APIError as exc:
            statuses.append(type(exc).__name__)
    _post_json(f"{args.api.rstrip('/')}/proxy/runs/{run_id}/finish", {})
    print(f"  statuses observed: {statuses}")
    print(f"  scorecard: {args.api.rstrip('/')}/runs/{run_id}/scorecard")
    print(f"  dashboard: open {args.api} and inspect run {run_id}")

    return 0 if same else 2


if __name__ == "__main__":
    sys.exit(main())
