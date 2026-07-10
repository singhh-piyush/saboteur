
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from saboteur.chaos.profile import ChaosProfile, load_profile
from saboteur.proxy.session import ProxySession

from . import inject, jsonrpc
from .telemetry import HttpEmitter, ListEmitter
from .upstream import UpstreamClient, split_upstream_command

_PROFILES_DIR = Path("profiles")
_DEFAULT_INGEST = "http://localhost:8000"


class ShimConfig:
    def __init__(self) -> None:
        self.run_id: str | None = None
        self.agent_id: int = 0
        self.profile: ChaosProfile | None = None
        self.ingest_url: str = _DEFAULT_INGEST
        self.upstream_cmd: list[str] = []


def _resolve_profile(value: str, seed: int | None) -> ChaosProfile:
    path = Path(value)
    if not (path.suffix or path.exists() or "/" in value):
        path = _PROFILES_DIR / f"{value}.yaml"
    profile = load_profile(path)
    if seed is not None:
        profile = profile.model_copy(update={"seed": seed})
    return profile


def parse_args(argv: list[str], env: dict[str, str]) -> ShimConfig:
    flags = argv
    upstream_from_argv: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        flags, upstream_from_argv = argv[:i], argv[i + 1 :]

    opts: dict[str, str] = {}
    j = 0
    while j < len(flags):
        tok = flags[j]
        if tok.startswith("--") and j + 1 < len(flags):
            opts[tok[2:]] = flags[j + 1]
            j += 2
        else:
            j += 1

    cfg = ShimConfig()
    cfg.run_id = opts.get("run") or env.get("SABOTEUR_RUN_ID") or None
    cfg.agent_id = int(opts.get("agent") or env.get("SABOTEUR_AGENT_ID") or "0")
    cfg.ingest_url = (
        opts.get("ingest") or env.get("SABOTEUR_INGEST_URL") or _DEFAULT_INGEST
    )

    seed_raw = opts.get("seed") or env.get("SABOTEUR_SEED")
    seed = int(seed_raw) if seed_raw else None
    profile_value = opts.get("profile") or env.get("SABOTEUR_PROFILE")
    if profile_value:
        cfg.profile = _resolve_profile(profile_value, seed)

    if upstream_from_argv:
        cfg.upstream_cmd = upstream_from_argv
    elif opts.get("upstream") or env.get("SABOTEUR_UPSTREAM"):
        cfg.upstream_cmd = split_upstream_command(
            opts.get("upstream") or env["SABOTEUR_UPSTREAM"]
        )
    return cfg


async def _stdio_streams() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
    )
    w_transport, w_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(w_transport, w_protocol, reader, loop)
    return reader, writer


async def serve(cfg: ShimConfig) -> int:
    if not cfg.upstream_cmd:
        print("saboteur-mcp: no upstream command (pass it after '--')", file=sys.stderr)
        return 2

    client_reader, client_writer = await _stdio_streams()

    async def forward_to_client(message: jsonrpc.Message) -> None:
        jsonrpc.write_message(client_writer, message)
        await client_writer.drain()

    upstream = UpstreamClient(cfg.upstream_cmd, on_unsolicited=forward_to_client)
    await upstream.start()

    session: ProxySession | None = None
    emit = None
    http_emitter: HttpEmitter | None = None
    if cfg.profile is not None:
        session = ProxySession(cfg.run_id or "mcp", cfg.agent_id, cfg.profile)
        if cfg.run_id:
            http_emitter = HttpEmitter(cfg.run_id, cfg.ingest_url)
            emit = http_emitter.emit
        else:
            emit = ListEmitter().emit  # faults apply; telemetry is dropped

    try:
        while True:
            msg = await jsonrpc.read_message(client_reader)
            if msg is None:
                break  # client disconnected
            await _dispatch(msg, session, emit, upstream, forward_to_client, cfg)
    finally:
        await upstream.close()
        if http_emitter is not None:
            http_emitter.close()
    return 0


async def _dispatch(
    msg: jsonrpc.Message,
    session: ProxySession | None,
    emit: Any,
    upstream: UpstreamClient,
    forward_to_client: Any,
    cfg: ShimConfig,
) -> None:
    method = msg.get("method")
    jid = msg.get("id")
    is_request = "id" in msg
    try:
        if session is not None and method == "tools/call" and is_request:

            async def upstream_call(params: dict[str, Any]) -> dict[str, Any]:
                resp = await upstream.request(
                    {"jsonrpc": "2.0", "id": jid, "method": "tools/call", "params": params}
                )
                if "error" in resp:
                    return {
                        "content": [
                            {"type": "text", "text": json.dumps(resp["error"])}
                        ],
                        "isError": True,
                    }
                return resp.get("result") or {}

            envelope = await inject.handle_tools_call(
                session,
                run_id=cfg.run_id or "",
                params=msg.get("params") or {},
                jsonrpc_id=jid,
                emit=emit,
                upstream_call=upstream_call,
            )
            await forward_to_client(envelope)

        elif session is not None and method == "tools/list" and is_request:
            resp = await upstream.request(msg)
            if "result" in resp and isinstance(resp["result"], dict):
                resp = {**resp, "result": inject.handle_tools_list(session, resp["result"])}
            await forward_to_client(resp)

        elif is_request:
            await forward_to_client(await upstream.request(msg))
        else:
            await upstream.notify(msg)
    except Exception as exc:
        if is_request:
            await forward_to_client(
                jsonrpc.error_response(jid, -32000, f"saboteur shim error: {exc}")
            )


def main() -> int:
    cfg = parse_args(sys.argv[1:], dict(os.environ))
    try:
        return asyncio.run(serve(cfg))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
