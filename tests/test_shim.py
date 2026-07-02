"""Unit tests for the BYO-agent shim (saboteur.proxy.shim).

The shim is public API (advertised in examples/byo_min_agent/README.md), so its
env → header mapping is pinned here. No network, no openai import needed for
the header path.
"""

from __future__ import annotations

from saboteur.proxy.shim import saboteur_headers


def test_headers_from_env(monkeypatch):
    monkeypatch.setenv("SABOTEUR_RUN_ID", "run-abc")
    monkeypatch.setenv("SABOTEUR_AGENT_ID", "3")
    assert saboteur_headers() == {
        "X-Saboteur-Run-Id": "run-abc",
        "X-Saboteur-Agent-Id": "3",
    }


def test_headers_empty_without_env(monkeypatch):
    monkeypatch.delenv("SABOTEUR_RUN_ID", raising=False)
    monkeypatch.delenv("SABOTEUR_AGENT_ID", raising=False)
    assert saboteur_headers() == {}


def test_headers_partial_env(monkeypatch):
    """An empty/unset id is omitted rather than sent as an empty header."""
    monkeypatch.setenv("SABOTEUR_RUN_ID", "run-abc")
    monkeypatch.setenv("SABOTEUR_AGENT_ID", "")
    assert saboteur_headers() == {"X-Saboteur-Run-Id": "run-abc"}
