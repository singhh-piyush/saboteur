#!/usr/bin/env python
"""A trivial stdlib MCP server (stdio) — the "real" server the shim wraps.

No dependencies: it speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, the
MCP stdio transport. Two tools:

  - ``get_weather(city)`` → ``"22.0°C (71.6°F)"`` (Tokyo), the deception
    ground-truth: Saboteur's ``silent_lie`` corrupts only the last number (°F),
    leaving °C true, so a lied reading is internally inconsistent. Matches
    ``saboteur/agents/task.py``'s GROUND_TRUTH.
  - ``add(a, b)`` → the numeric sum.

Run it directly to sanity-check, or register it as the upstream behind the shim
(see README). It is intentionally minimal — just enough protocol for a client to
initialize, list tools, and call them.
"""

from __future__ import annotations

import json
import sys
from typing import Any

PROTOCOL_VERSION = "2024-11-05"

_WEATHER = {"Tokyo": "22.0°C (71.6°F)", "Kyoto": "21.0°C (69.8°F)"}

TOOLS = [
    {
        "name": "get_weather",
        "description": "Current weather for a city, as '<C>°C (<F>°F)'.",
        "inputSchema": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
    {
        "name": "add",
        "description": "Add two numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
]


def _text(text: str, *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "get_weather":
        city = args.get("city", "Tokyo")
        return _text(_WEATHER.get(city, f"No data for {city}."))
    if name == "add":
        return _text(str(float(args.get("a", 0)) + float(args.get("b", 0))))
    return _text(f"Unknown tool: {name}", is_error=True)


def _handle(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mcp-min", "version": "0.1.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params") or {}
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": _call(params.get("name", ""), params.get("arguments") or {}),
        }
    if method and method.startswith("notifications/"):
        return None  # notifications get no response
    if "id" in msg:
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    return None


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except (TypeError, ValueError):
            continue
        reply = _handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
