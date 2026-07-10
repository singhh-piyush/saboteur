
from __future__ import annotations

from collections.abc import AsyncIterator, Mapping

import httpx

from saboteur.config import get_settings

# skip hop-by-hop and custom attribution headers
_SKIP_HEADERS = {
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "transfer-encoding",
}

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # long client timeout as completion streams take time
        _client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))
    return _client


async def aclose_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _upstream_url(subpath: str) -> str:
    base = get_settings().upstream_base_url.rstrip("/")
    return f"{base}/{subpath.lstrip('/')}"


def forward_headers(headers: Mapping[str, str]) -> dict[str, str]:
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
    client = get_client()
    async with client.stream(
        "POST",
        _upstream_url(subpath),
        content=body,
        headers=forward_headers(headers),
    ) as resp:
        async for chunk in resp.aiter_bytes():
            yield chunk
