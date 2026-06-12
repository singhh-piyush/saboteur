#!/usr/bin/env python3
"""Replay a recorded JSONL run through the live dashboard.

Usage::

    python scripts/replay.py runs/my-run.jsonl
    python scripts/replay.py --speed 5 --api http://localhost:8000 runs/my-run.jsonl

The script calls POST /replay on the running Saboteur server, then connects
to the returned run_id's WS channel and prints each event as JSON.
Press Ctrl+C to stop.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx
import websockets


async def replay(api: str, jsonl_path: str, speed: float) -> None:
    async with httpx.AsyncClient(base_url=api, timeout=10.0) as client:
        resp = await client.post(
            "/replay",
            json={"jsonl_path": jsonl_path, "speed": speed},
        )
        if resp.status_code >= 400:
            print(f"Error {resp.status_code}: {resp.text}", file=sys.stderr)
            sys.exit(1)
        run_id = resp.json()["run_id"]
        print(f"Replay run_id: {run_id}", flush=True)

    ws_url = api.replace("http://", "ws://").replace("https://", "wss://")
    async with websockets.connect(f"{ws_url}/ws/{run_id}") as ws:
        async for message in ws:
            print(json.dumps(json.loads(message)), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay a Saboteur JSONL run.")
    parser.add_argument("jsonl_path", help="Path to the .jsonl file to replay")
    parser.add_argument(
        "--api", default="http://localhost:8000", help="Saboteur API base URL"
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Replay speed multiplier (1.0 = real-time, 0 = instant)",
    )
    args = parser.parse_args()

    try:
        asyncio.run(replay(args.api, args.jsonl_path, args.speed))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
