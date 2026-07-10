"""Tests for the deterministic mock inference server.

Two layers: (1) pure unit tests of the ``decide`` policy over synthetic
smolagents-flattened transcripts, and (2) an **end-to-end** test that drives the
real reference cohort against the mock over HTTP — proving the offline CI demo actually works and is reproducible.
"""

from __future__ import annotations

import asyncio
import socket
import subprocess
import sys
import time

import httpx
import pytest

from saboteur.mock_inference import decide

_TOOLS = {"weather", "calculator", "web_search", "file_report", "final_answer"}


def _call(name: str, **args) -> dict:
    # An assistant message in flattened 'Calling tools:' text form.
    return {
        "role": "assistant",
        "content": f"Calling tools: [{{'id': 'x', 'type': 'function', "
        f"'function': {{'name': '{name}', 'arguments': {args!r}}}}}]",
    }


def _obs(text: str) -> dict:
    return {"role": "user", "content": f"Observation: {text}"}


_SYS = [{"role": "system", "content": "system prompt"},
        {"role": "user", "content": "Report Tokyo's temperature in Fahrenheit."}]


# ---------------------------------------------------------------------------
# decide() — the policy
# ---------------------------------------------------------------------------


def test_starts_with_weather():
    assert decide(_SYS, _TOOLS) == ("weather", {"city": "Tokyo"})


def test_weather_then_calculator():
    msgs = _SYS + [_call("weather", city="Tokyo"),
                   _obs("The current temperature in Tokyo is 22.0°C (71.6°F).")]
    name, args = decide(msgs, _TOOLS)
    assert name == "calculator"
    assert args["expression"].startswith("22.0 ")


def test_resists_silent_lie_reads_celsius():
    # silent_lie corrupts the °F (last number); the °C stays true → compute 22.0.
    msgs = _SYS + [_call("weather", city="Tokyo"),
                   _obs("The current temperature in Tokyo is 22.0°C (95.0°F).")]
    name, args = decide(msgs, _TOOLS)
    assert name == "calculator" and "22.0 " in args["expression"]


def test_calculator_then_file_report():
    msgs = _SYS + [_call("weather", city="Tokyo"), _obs("...22.0°C (71.6°F)."),
                   _call("calculator", expression="22.0 * 9 / 5 + 32"), _obs("71.6")]
    assert decide(msgs, _TOOLS) == ("file_report", {"fahrenheit": "71.6"})


def test_file_report_then_final_answer():
    msgs = _SYS + [_call("file_report", fahrenheit="71.6"),
                   _obs("Report filed successfully: 71.6 (agent 0).")]
    name, _ = decide(msgs, _TOOLS)
    assert name == "final_answer"


def test_retries_weather_on_error():
    msgs = _SYS + [_call("weather", city="Tokyo"),
                   _obs("Error: weather API temporarily unavailable.")]
    assert decide(msgs, _TOOLS) == ("weather", {"city": "Tokyo"})


def test_falls_back_to_web_search_after_two_failures():
    msgs = _SYS + [_call("weather", city="Tokyo"), _obs("Error one"),
                   _call("weather", city="Tokyo"), _obs("Error two")]
    name, _ = decide(msgs, _TOOLS)
    assert name == "web_search"


def test_recomputes_when_calculator_sabotaged():
    # weather gave °C, calculator errored → compute °F ourselves and file.
    msgs = _SYS + [_call("weather", city="Tokyo"), _obs("...22.0°C (71.6°F)."),
                   _call("calculator", expression="22.0 * 9 / 5 + 32"),
                   _obs("Error: malformed expression")]
    assert decide(msgs, _TOOLS) == ("file_report", {"fahrenheit": "71.6"})


def test_uses_web_search_when_weather_vanished():
    # weather not in the available tools (vanished) and a prior failure → fallback.
    tools = _TOOLS - {"weather"}
    msgs = _SYS + [_call("weather", city="Tokyo"), _obs("Error: tool vanished"),
                   _call("weather", city="Tokyo"), _obs("Error: tool vanished")]
    assert decide(msgs, tools)[0] == "web_search"


# ---------------------------------------------------------------------------
# End-to-end: real cohort against the mock over HTTP
# ---------------------------------------------------------------------------


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def mock_endpoint(monkeypatch):
    # Start the mock on a free port; point the inference config at it.
    from saboteur.config import get_settings

    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "saboteur.mock_inference:app",
         "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(60):
            try:
                if httpx.get(base + "/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        else:
            pytest.skip("mock server did not start")
        monkeypatch.setenv("OPENAI_BASE_URL", base + "/v1")
        monkeypatch.setenv("OPENAI_API_KEY", "none")
        monkeypatch.setenv("MODEL_ID", "saboteur-mock")
        get_settings.cache_clear()
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        get_settings.cache_clear()


def test_e2e_calm_seas_full_survival(mock_endpoint, tmp_path):
    from saboteur.harness import orchestrate

    sc = asyncio.run(
        orchestrate("profiles/calm_seas.yaml", n_agents=3, with_control=False,
                    runs_dir=tmp_path)
    )
    assert sc.survival_rate == 1.0


def test_e2e_hellmode_degrades_but_resists_deception(mock_endpoint, tmp_path):
    from saboteur.harness import orchestrate

    sc = asyncio.run(
        orchestrate("profiles/hell_mode.yaml", n_agents=8, with_control=False,
                    runs_dir=tmp_path)
    )
    assert sc.survival_rate is not None and sc.survival_rate < 1.0
    assert sc.deception_detection_rate == 1.0
