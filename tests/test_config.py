"""Smoke tests for saboteur.config.

These tests run without a .env file and without a live LLM endpoint.
They verify that Settings loads with correct defaults and that get_settings()
returns the singleton (same object on repeated calls).
"""


import pytest

import saboteur.config as cfg_module


# Every env var Settings reads. smolagents (imported by saboteur.config)
# calls load_dotenv() at import time, copying the developer's .env into
# os.environ — so without scrubbing these, the "default" tests below would
# assert against whatever .env the checkout happens to have (e.g. a leftover
# MI300X config), not the built-in defaults.
_SETTINGS_ENV_VARS = (
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "MODEL_ID",
    "UPSTREAM_BASE_URL",
    "PROXY_IDLE_TIMEOUT_S",
    "PROXY_PUBLIC_BASE_URL",
    "TEMPERATURE",
    "MODEL_SEED",
    "TOOL_CHOICE",
    "N_AGENTS",
    "MAX_STEPS",
    "AGENT_TIMEOUT_S",
    "CONCURRENCY_LIMIT",
)


@pytest.fixture(autouse=True)
def clear_settings_cache(monkeypatch):
    """Fresh Settings per test: clear the lru_cache + scrub ambient env vars."""
    for name in _SETTINGS_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
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
    # The heavy-model knob: a raised ceiling must reach settings (factory's
    # asyncio.wait_for reads it from here — see test_factory's timeout test).
    monkeypatch.setenv("AGENT_TIMEOUT_S", "600")
    s = cfg_module.get_settings()
    assert s.n_agents == 4
    assert s.model_id == "my-custom-model"
    assert s.agent_timeout_s == 600


def test_default_tool_choice(monkeypatch, tmp_path):
    """tool_choice defaults to 'required'."""
    monkeypatch.chdir(tmp_path)
    s = cfg_module.get_settings()
    assert s.tool_choice == "required"


def test_tool_choice_env_override(monkeypatch, tmp_path):
    """TOOL_CHOICE env var overrides the default."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TOOL_CHOICE", "auto")
    s = cfg_module.get_settings()
    assert s.tool_choice == "auto"


def test_tool_choice_forwarded_to_outgoing_request(monkeypatch, tmp_path):
    """tool_choice=required must appear in every chat.completions.create call.

    This is the offline proof that the kwarg reaches the wire: we monkeypatch
    ``client.chat.completions.create`` to capture the kwargs it is called with,
    fire a generate() through the live code path, then assert the captured
    kwargs carry ``tool_choice="required"``.
    """
    from types import SimpleNamespace

    monkeypatch.chdir(tmp_path)

    model = cfg_module.get_model()

    # Minimal fake response that OpenAIModel.generate() can unwrap.
    # smolagents._coerce_tool_call requires a ChatMessageToolCall (or dict /
    # model_dump-able), so we use the real type rather than SimpleNamespace.
    from smolagents.models import ChatMessageToolCall, ChatMessageToolCallFunction

    fake_tool_call = ChatMessageToolCall(
        id="call_0",
        type="function",
        function=ChatMessageToolCallFunction(name="dummy_tool", arguments="{}"),
    )
    fake_choice = SimpleNamespace(
        message=SimpleNamespace(
            role="assistant",
            content=None,
            tool_calls=[fake_tool_call],
        )
    )
    fake_response = SimpleNamespace(
        choices=[fake_choice],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
    )

    captured: dict = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return fake_response

    # Patch the underlying OpenAI client's create method.
    model.client.chat.completions.create = fake_create

    # A minimal Tool-like object satisfying get_tool_json_schema.
    # We use a real saboteur tool so we don't need to replicate smolagents
    # schema internals.
    from saboteur.agents.tools import ReportStore, build_tools
    tools = build_tools(0, ReportStore())

    from smolagents.models import ChatMessage, MessageRole
    model.generate(
        [ChatMessage(role=MessageRole.USER, content="ping")],
        tools_to_call_from=tools,
    )

    assert "tool_choice" in captured, "tool_choice was not forwarded to create()"
    assert captured["tool_choice"] == "required", (
        f"Expected tool_choice='required', got {captured['tool_choice']!r}"
    )
