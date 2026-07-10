
from __future__ import annotations

import os
from typing import Any

_ENV_TO_HEADER = {
    "SABOTEUR_RUN_ID": "X-Saboteur-Run-Id",
    "SABOTEUR_AGENT_ID": "X-Saboteur-Agent-Id",
}


def saboteur_headers() -> dict[str, str]:
    return {
        header: os.environ[env]
        for env, header in _ENV_TO_HEADER.items()
        if os.environ.get(env)
    }


def saboteur_client(**kwargs: Any) -> Any:
    from openai import OpenAI

    kwargs.setdefault("base_url", os.environ.get("OPENAI_BASE_URL"))
    kwargs.setdefault("api_key", os.environ.get("OPENAI_API_KEY", "none"))
    kwargs.setdefault("default_headers", saboteur_headers())
    return OpenAI(**kwargs)
