"""Inference swap layer and global settings.

Swapping local llama.cpp ↔ vLLM on MI300X is configured via env vars.
"""

import functools

from pydantic_settings import BaseSettings, SettingsConfigDict
from smolagents import OpenAIServerModel


class Settings(BaseSettings):
    """Reads configuration from the environment / .env file.

    Pydantic-settings maps env var names case-insensitively, so
    ``OPENAI_BASE_URL`` in .env populates ``openai_base_url`` here.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_base_url: str = "http://localhost:8080/v1"
    openai_api_key: str = "none"
    model_id: str = "llama-3.1-8b-instruct"

    # where the proxy forwards. byo agents point OPENAI_BASE_URL here
    upstream_base_url: str = "http://localhost:8080/v1"
    # finish run after this many seconds of inactivity from any session
    proxy_idle_timeout_s: int = 120
    # externally reachable URL of this app where the proxy is mounted
    proxy_public_base_url: str = "http://localhost:8000"
    # small models stall at temp=0; 0.3 breaks greedy loops and lifts survival
    temperature: float = 0.3
    model_seed: int | None = 42
    # force tool call on every turn; set auto if a backend rejects the parameter
    tool_choice: str = "required"

    n_agents: int = 8
    max_steps: int = 15
    agent_timeout_s: int = 180
    # max concurrent agents; 0 means unlimited
    concurrency_limit: int = 8


@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def get_model() -> OpenAIServerModel:
    # construct OpenAIServerModel from settings; do not instantiate elsewhere
    s = get_settings()
    return OpenAIServerModel(
        model_id=s.model_id,
        api_base=s.openai_base_url,
        api_key=s.openai_api_key,
        temperature=s.temperature,
        seed=s.model_seed,
        # stored on the model to guarantee constrained generation on every call
        tool_choice=s.tool_choice,
    )
