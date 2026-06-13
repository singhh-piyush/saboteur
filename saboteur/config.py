"""Inference swap layer and global settings.

This is the ONLY place in the codebase where the model / endpoint is constructed.
Swapping local llama.cpp ↔ vLLM on MI300X is a pure .env change — no code edits.

Usage::

    from saboteur.config import get_model, get_settings

    model = get_model()          # smolagents OpenAIServerModel
    s = get_settings()           # pydantic-settings Settings singleton
    print(s.n_agents, s.model_id)
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

    # --- Inference ---
    openai_base_url: str = "http://localhost:8080/v1"
    openai_api_key: str = "none"
    model_id: str = "llama-3.1-8b-instruct"
    # Small local models (Llama-3.1-8B-Q4) deterministically stall at temp=0:
    # after computing the answer they emit empty "Action:" turns with no tool
    # call, looping to the step cap (the WP3 control-validity bug). A little
    # temperature breaks that greedy loop and lifts local control survival to
    # ceiling, so 0.3 is the default. Note: end-to-end reproducibility is
    # already not guaranteed on live runs (llama.cpp -np N batching is
    # non-deterministic even at temp=0); invariant #1 holds for an *identical
    # tool-call sequence*, which is independent of temperature. Set TEMPERATURE=0
    # if a backend ever needs strict greedy decoding. MODEL_SEED stays fixed.
    temperature: float = 0.3
    model_seed: int | None = 42
    # Force the model to emit a tool call on every turn. llama.cpp (--jinja)
    # and vLLM both enforce this via constrained generation. Set TOOL_CHOICE=auto
    # if a future backend rejects the parameter (e.g. no tools-API support).
    tool_choice: str = "required"

    # --- Harness knobs ---
    n_agents: int = 8
    max_steps: int = 15
    agent_timeout_s: int = 180
    # Max agents running concurrently; 0 = unlimited. Local default matches
    # llama.cpp's -np 8 parallel slots; the MI300X .env raises or disables it.
    concurrency_limit: int = 8


@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the global Settings singleton (cached after first call)."""
    return Settings()


def get_model() -> OpenAIServerModel:
    """Construct an OpenAIServerModel from current settings.

    Every agent and every module that needs the model calls this function.
    Never instantiate OpenAIServerModel anywhere else in the codebase.
    """
    s = get_settings()
    return OpenAIServerModel(
        model_id=s.model_id,
        api_base=s.openai_base_url,
        api_key=s.openai_api_key,
        temperature=s.temperature,
        seed=s.model_seed,
        # Stored in model.kwargs → applied at highest priority on every
        # chat.completions.create call (models.py:546-550). This guarantees
        # constrained generation even across smolagents version upgrades.
        tool_choice=s.tool_choice,
    )
