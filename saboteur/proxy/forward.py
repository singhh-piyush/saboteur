"""Upstream transport for the proxy — forward to the real OpenAI-compatible API.

A single shared ``httpx.AsyncClient`` forwards requests to
``settings.upstream_base_url`` (the local llama.cpp or the MI300X vLLM). The
proxy returns **raw upstream bytes** so a passthrough (calm_seas / no fault this
request) is content-identical to hitting the upstream directly — the transparency
contract. The client is created lazily and closed by an app shutdown hook
(see ``saboteur.api``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping

import httpx

from saboteur.config import get_settings

# Headers we never forward upstream: hop-by-hop / length that httpx recomputes,
# our own attribution headers, and accept-encoding (we want identity bytes back,
# so passthrough byte-comparison stays meaningful).
_SKIP_HEADERS = {
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "transfer-encoding",
}

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Return the shared upstream client, creating it on first use."""
    global _client
    if _client is None:
        # Long read timeout: completions (esp. streamed) can take a while; the
        # proxy's own ``timeout`` fault is what bounds a run, not this.
        _client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))
    return _client


async def aclose_client() -> None:
    """Close the shared client (app shutdown). Idempotent."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _upstream_url(subpath: str) -> str:
    base = get_settings().upstream_base_url.rstrip("/")
    return f"{base}/{subpath.lstrip('/')}"


def forward_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """Copy client headers minus hop-by-hop / attribution headers."""
    out: dict[str, str] = {}
    for key, value in headers.items():
        kl = key.lower()
        if kl in _SKIP_HEADERS or kl.startswith("x-saboteur"):
            continue
        out[key] = value
    return out


async def forward_nonstream(
    subpath: str,
    headers: Mapping[str, str],
    body: bytes,
    *,
    method: str = "POST",
) -> tuple[int, httpx.Headers, bytes]:
    """Forward a request and return ``(status, headers, raw_body_bytes)``."""
    client = get_client()
    resp = await client.request(
        method,
        _upstream_url(subpath),
        content=body if method != "GET" else None,
        headers=forward_headers(headers),
    )
    return resp.status_code, resp.headers, resp.content


async def stream_passthrough(
    subpath: str,
    headers: Mapping[str, str],
    body: bytes,
) -> AsyncIterator[bytes]:
    """Stream raw upstream chunks for a ``stream:true`` request (SSE passthrough).

    Holds the upstream response open for the lifetime of the iteration; the
    ``async with`` guarantees it is closed even if the client disconnects.
    """
    client = get_client()
    async with client.stream(
        "POST",
        _upstream_url(subpath),
        content=body,
        headers=forward_headers(headers),
    ) as resp:
        async for chunk in resp.aiter_bytes():
            yield chunk
