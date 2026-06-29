"""Static checks on the GitHub Action assets — they parse and declare what the
docs promise. (The live green/red + PR-comment behaviour is verified by the
mock cohort tests + the container smoke; here we guard the wiring.)"""

from __future__ import annotations

from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parent.parent
_ACTION = _ROOT / ".github/actions/saboteur-resilience/action.yml"
_ENTRY = _ROOT / ".github/actions/saboteur-resilience/entrypoint.sh"
_WORKFLOW = _ROOT / ".github/workflows/resilience.yml"


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_action_is_composite_with_documented_inputs():
    action = _load(_ACTION)
    assert action["runs"]["using"] == "composite"
    inputs = set(action["inputs"])
    assert {"target", "profile", "n", "threshold", "metric", "mock"} <= inputs
    assert {"openai-base-url", "openai-api-key", "model-id", "github-token"} <= inputs


def test_action_steps_cover_gate_artifact_comment_enforce():
    # Sanity that it's valid YAML, then assert the wiring against the raw text.
    assert _load(_ACTION)["runs"]["steps"]
    raw = _ACTION.read_text(encoding="utf-8")
    assert "docker build" in raw
    assert 'entrypoint.sh" gate' in raw
    assert "actions/upload-artifact" in raw
    assert 'entrypoint.sh" compare' in raw
    assert "gate.outputs.gate_exit" in raw  # final step fails on non-zero exit
    assert "pull_request" in raw  # comment step is PR-gated


def test_entrypoint_has_gate_and_compare():
    src = _ENTRY.read_text(encoding="utf-8")
    assert "cmd_gate" in src and "cmd_compare" in src
    assert "saboteur-resilience" in src  # the PR-comment upsert marker
    assert "gh run download" in src  # fetch the base branch's last scorecard
    assert "docker_run compare" in src  # uses the in-container compare endpoint


def test_workflow_triggers_and_permissions():
    wf = _load(_WORKFLOW)
    # YAML 1.1 parses the bare key `on:` as the boolean True.
    triggers = wf.get("on") or wf.get(True)
    assert "pull_request" in triggers and "push" in triggers
    perms = wf["permissions"]
    assert perms["pull-requests"] == "write"
    assert perms["actions"] == "read"
    assert perms["contents"] == "read"


def test_workflow_uses_local_action_with_mock_default():
    wf = _load(_WORKFLOW)
    step = next(
        s for s in wf["jobs"]["resilience"]["steps"]
        if str(s.get("uses", "")).startswith("./.github/actions/saboteur-resilience")
    )
    assert step["with"]["target"] == "reference"
    assert str(step["with"]["mock"]) == "true"
