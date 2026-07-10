# newline-delimited json-rpc 2.0 wire framing

from __future__ import annotations

import asyncio
import json
from typing import Any

Message = dict[str, Any]


async def read_message(reader: asyncio.StreamReader) -> Message | None:
    # read message skipping blank or invalid json lines
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
    # write message as a single newline-terminated json line
    data = (json.dumps(message) + "\n").encode("utf-8")
    writer.write(data)


def error_response(jsonrpc_id: Any, code: int, message: str) -> Message:
    return {"jsonrpc": "2.0", "id": jsonrpc_id, "error": {"code": code, "message": message}}


def result_response(jsonrpc_id: Any, result: Message) -> Message:
    return {"jsonrpc": "2.0", "id": jsonrpc_id, "result": result}
