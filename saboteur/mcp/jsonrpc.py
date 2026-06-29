"""Minimal MCP stdio framing: newline-delimited JSON-RPC 2.0.

The MCP stdio transport is the simplest possible wire: each JSON-RPC message is a
single UTF-8 line (one JSON object, no embedded newlines) on stdin/stdout; stderr
is free for logging. We implement it by hand (stdlib only) rather than depend on
the ``mcp`` SDK — it keeps the shim a thin, transparent relay (any method passes
through) and the tests offline/deterministic, matching the wire proxy's ethos.

Both directions (the client↔shim pipe and the shim↔upstream subprocess pipe) use
``asyncio`` streams, so the same two functions serve every hop.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

Message = dict[str, Any]


async def read_message(reader: asyncio.StreamReader) -> Message | None:
    """Read one JSON-RPC message, or ``None`` at EOF.

    Blank lines (some servers pad output) are skipped. A line that is not valid
    JSON is skipped too (best-effort transparency — never crash the relay).
    """
    while True:
        line = await reader.readline()
        if not line:
            return None  # EOF
        text = line.strip()
        if not text:
            continue
        try:
            obj = json.loads(text)
        except (TypeError, ValueError):
            continue
        if isinstance(obj, dict):
            return obj


def write_message(writer: asyncio.StreamWriter, message: Message) -> None:
    """Write one JSON-RPC message as a single line (no embedded newlines).

    ``json.dumps`` never emits a raw newline, so the one we append is the only
    one — the framing contract. The caller should ``await writer.drain()`` if it
    needs back-pressure; for our low message rate a fire-and-forget write is fine.
    """
    data = (json.dumps(message) + "\n").encode("utf-8")
    writer.write(data)


def error_response(jsonrpc_id: Any, code: int, message: str) -> Message:
    """A JSON-RPC error envelope (used when the relay itself fails)."""
    return {"jsonrpc": "2.0", "id": jsonrpc_id, "error": {"code": code, "message": message}}


def result_response(jsonrpc_id: Any, result: Message) -> Message:
    """A JSON-RPC success envelope."""
    return {"jsonrpc": "2.0", "id": jsonrpc_id, "result": result}
