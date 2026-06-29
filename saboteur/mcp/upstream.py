"""The shim's client to the user's real MCP server.

``UpstreamClient`` launches the wrapped MCP server (``command + args``) as an
``asyncio`` subprocess over stdio and relays JSON-RPC to it. The shim serializes
client traffic (one request at a time over the single stdio pipe), so a simple
write-then-read-until-matching-id loop is sufficient — no out-of-order plumbing.
Any server→client message without an ``id`` (a notification / log) is surfaced to
the caller via ``on_unsolicited`` so the shim can forward it transparently.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Awaitable, Callable

from .jsonrpc import Message, read_message, write_message


class UpstreamClient:
    """A thin stdio JSON-RPC client to one wrapped MCP server subprocess."""

    def __init__(
        self,
        command: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        on_unsolicited: Callable[[Message], Awaitable[None]] | None = None,
    ) -> None:
        self.command = command
        self.env = env
        self.cwd = cwd
        self._on_unsolicited = on_unsolicited
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=sys.stderr,  # let the wrapped server log straight to our stderr
            env=self.env,
            cwd=self.cwd,
        )

    @property
    def _stdin(self) -> asyncio.StreamWriter:
        assert self._proc is not None and self._proc.stdin is not None
        return self._proc.stdin

    @property
    def _stdout(self) -> asyncio.StreamReader:
        assert self._proc is not None and self._proc.stdout is not None
        return self._proc.stdout

    async def request(self, message: Message) -> Message:
        """Send a request and return its matching response.

        Forwards any intervening id-less messages to ``on_unsolicited``. Raises
        ``ConnectionError`` if the upstream closes before responding.
        """
        want = message.get("id")
        async with self._lock:
            write_message(self._stdin, message)
            await self._stdin.drain()
            while True:
                reply = await read_message(self._stdout)
                if reply is None:
                    raise ConnectionError("upstream MCP server closed the connection")
                if reply.get("id") == want and ("result" in reply or "error" in reply):
                    return reply
                # A server-initiated notification / log: surface it, keep reading.
                if self._on_unsolicited is not None:
                    await self._on_unsolicited(reply)

    async def notify(self, message: Message) -> None:
        """Send a notification (no response expected)."""
        async with self._lock:
            write_message(self._stdin, message)
            await self._stdin.drain()

    async def close(self) -> None:
        if self._proc is None:
            return
        proc = self._proc
        self._proc = None
        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except (asyncio.TimeoutError, Exception):
            try:
                proc.kill()
            except ProcessLookupError:
                pass


def split_upstream_command(value: str) -> list[str]:
    """Parse an upstream command string (``SABOTEUR_UPSTREAM``) into argv."""
    import shlex

    return shlex.split(value)
