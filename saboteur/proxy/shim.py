"""Tiny BYO-agent shim: forward Saboteur attribution headers to the proxy.

When the cohort spawner launches a BYO agent it sets these env vars per copy:

- ``OPENAI_BASE_URL`` → the wire proxy (``http://host:8000/v1``)
- ``OPENAI_API_KEY``  → ``none`` (local) unless the target provides one
- ``SABOTEUR_RUN_ID`` / ``SABOTEUR_AGENT_ID`` → this agent's proxy session

The agent must forward the two ids as the ``X-Saboteur-Run-Id`` /
``X-Saboteur-Agent-Id`` HTTP headers so the proxy attributes (and sabotages) its
traffic. This module wires that up for OpenAI-SDK agents; agents using another
client just need to set the same two headers (see :func:`saboteur_headers`).

Self-contained on purpose — the bundled ``examples/byo_min_agent`` inlines the
same few lines so it works without importing ``saboteur``.
"""

from __future__ import annotations

import os
from typing import Any

_ENV_TO_HEADER = {
    "SABOTEUR_RUN_ID": "X-Saboteur-Run-Id",
    "SABOTEUR_AGENT_ID": "X-Saboteur-Agent-Id",
}


def saboteur_headers() -> dict[str, str]:
    """The attribution headers to send on every request (from env)."""
    return {
        header: os.environ[env]
        for env, header in _ENV_TO_HEADER.items()
        if os.environ.get(env)
    }


def saboteur_client(**kwargs: Any) -> Any:
    """An ``openai.OpenAI`` client pre-wired with base_url/key + Saboteur headers.

    ``base_url`` / ``api_key`` default to ``OPENAI_BASE_URL`` / ``OPENAI_API_KEY``
    from the environment; pass overrides via ``**kwargs``.
    """
    from openai import OpenAI

    kwargs.setdefault("base_url", os.environ.get("OPENAI_BASE_URL"))
    kwargs.setdefault("api_key", os.environ.get("OPENAI_API_KEY", "none"))
    kwargs.setdefault("default_headers", saboteur_headers())
    return OpenAI(**kwargs)
