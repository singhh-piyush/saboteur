"""Smoke tests for saboteur.config.

These tests run without a .env file and without a live LLM endpoint.
They verify that Settings loads with correct defaults and that get_settings()
returns the singleton (same object on repeated calls).
"""


import pytest

import saboteur.config as cfg_module


@pytest.fixture(autouse=True)
def clear_settings_cache():
    """Reset the lru_cache between tests so each test gets a fresh Settings."""
    cfg_module.get_settings.cache_clear()
    yield
    cfg_module.get_settings.cache_clear()


def test_default_n_agents(monkeypatch, tmp_path):
    # Point pydantic-settings at a non-existent .env so it uses pure defaults.
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.n_agents == 8


def test_default_max_steps(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.max_steps == 15


def test_default_agent_timeout(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.agent_timeout_s == 180


def test_default_model_id(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.model_id == "llama-3.1-8b-instruct"


def test_default_base_url(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.openai_base_url == "http://localhost:8080/v1"


def test_singleton(monkeypatch, tmp_path):
    """get_settings() must return the same object on repeated calls."""
    monkeypatch.chdir(tmp_path)
    assert cfg_module.get_settings() is cfg_module.get_settings()


def test_env_override(monkeypatch, tmp_path):
    """Environment variables override built-in defaults."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("N_AGENTS", "4")
    monkeypatch.setenv("MODEL_ID", "my-custom-model")
    s = cfg_module.get_settings()
    assert s.n_agents == 4
    assert s.model_id == "my-custom-model"
