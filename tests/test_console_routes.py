"""Tests for the Chaos Console's additive backend routes.

Covers the routes the dashboard's new management pages depend on:

- ``GET  /faults``            — the fault catalog that drives the Profile Builder.
- ``POST /profiles/validate`` — dry-run schema validation.
- ``POST /profiles``          — save a custom profile (built-ins protected).
- ``DELETE /profiles/{name}`` — delete a custom profile (built-ins protected).
- ``PUT  /targets/{name}``    — edit a command target (+ oracle-config validation).

All LLM-free. Profile tests redirect ``_PROFILES_DIR`` to a temp dir; target
tests redirect the store to a temp-path :class:`Database`.
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from saboteur.api import app
from saboteur.harness.targets import TargetStore
from saboteur.storage.db import Database


# ---------------------------------------------------------------------------
# GET /faults
# ---------------------------------------------------------------------------


def test_faults_catalog_lists_all_eight():
    with TestClient(app) as client:
        catalog = client.get("/faults").json()
    by_type = {f["type"]: f for f in catalog}
    assert set(by_type) == {
        "api_error", "rate_limit", "malformed", "silent_lie",
        "tool_vanish", "latency", "timeout", "context_drop",
    }
    # Layers come from the chaos LAYER map.
    assert by_type["latency"]["layer"] == "transport"
    assert by_type["context_drop"]["layer"] == "context"
    assert by_type["api_error"]["layer"] == "tool"


def test_faults_catalog_required_params():
    with TestClient(app) as client:
        catalog = {f["type"]: f for f in client.get("/faults").json()}
    assert catalog["rate_limit"]["required"] == ["retry_after_s"]
    assert catalog["latency"]["required"] == ["delay_s"]
    assert catalog["context_drop"]["required"] == ["drop_last_k"]
    # rate_limit exposes its optional knobs too, with a UI kind + a default seed.
    params = {p["name"]: p for p in catalog["rate_limit"]["params"]}
    assert params["retry_after_s"]["kind"] == "range"
    assert params["retry_after_s"]["required"] is True
    assert params["retry_after_s"]["default"] == [2.0, 8.0]
    assert params["burst_budget"]["kind"] == "int"
    assert params["burst_budget"]["required"] is False


# ---------------------------------------------------------------------------
# Profile validate / save / delete
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_profiles(tmp_path, monkeypatch):
    import saboteur.api.profiles as profiles_mod

    monkeypatch.setattr(profiles_mod, "_PROFILES_DIR", tmp_path)
    return tmp_path


def test_validate_accepts_good_draft():
    draft = {
        "name": "ok",
        "seed": 7,
        "faults": [
            {"type": "rate_limit", "probability": 0.5, "retry_after_s": [2, 8]},
        ],
    }
    with TestClient(app) as client:
        res = client.post("/profiles/validate", json=draft).json()
    assert res["valid"] is True
    assert res["errors"] == []


def test_validate_flags_missing_required_param():
    draft = {"name": "bad", "seed": 1, "faults": [{"type": "rate_limit", "probability": 0.5}]}
    with TestClient(app) as client:
        res = client.post("/profiles/validate", json=draft).json()
    assert res["valid"] is False
    assert any("retry_after_s" in e["msg"] for e in res["errors"])


def test_validate_flags_out_of_range_probability():
    draft = {"name": "bad", "seed": 1, "faults": [{"type": "malformed", "probability": 2.0}]}
    with TestClient(app) as client:
        res = client.post("/profiles/validate", json=draft).json()
    assert res["valid"] is False
    assert any("probability" in e["loc"] for e in res["errors"])


def test_save_custom_profile_roundtrips(tmp_profiles):
    draft = {
        "name": "my_chaos",
        "seed": 99,
        "description": "built in the UI",
        "faults": [
            {"type": "latency", "probability": 0.3, "delay_s": [1, 4]},
            {"type": "malformed", "probability": 0.2},
        ],
    }
    with TestClient(app) as client:
        created = client.post("/profiles", json=draft)
        assert created.status_code == 201
        assert created.json()["name"] == "my_chaos"

        # Written to disk and visible immediately via GET /profiles.
        listed = {p["name"]: p for p in client.get("/profiles").json()}
        assert "my_chaos" in listed
        assert listed["my_chaos"]["seed"] == 99

    # The saved YAML is a valid profile the loader can read back.
    from saboteur.chaos.profile import load_profile

    profile = load_profile(tmp_profiles / "my_chaos.yaml")
    assert profile.seed == 99
    assert {str(f.type) for f in profile.faults} == {"latency", "malformed"}


def test_get_full_profile_roundtrips_params(tmp_profiles):
    draft = {
        "name": "full_one",
        "seed": 5,
        "faults": [
            {"type": "rate_limit", "probability": 0.4, "retry_after_s": [3, 9]},
        ],
    }
    with TestClient(app) as client:
        client.post("/profiles", json=draft)
        full = client.get("/profiles/full_one")
        assert full.status_code == 200
        body = full.json()
        assert body["seed"] == 5
        fault = body["faults"][0]
        assert fault["type"] == "rate_limit"
        # The full profile carries every fault param (not just the summary).
        assert fault["retry_after_s"] == [3.0, 9.0]

        assert client.get("/profiles/missing").status_code == 404


def test_save_builtin_name_is_409(tmp_profiles):
    draft = {"name": "calm_seas", "seed": 0, "faults": []}
    with TestClient(app) as client:
        assert client.post("/profiles", json=draft).status_code == 409


def test_save_bad_name_is_400(tmp_profiles):
    draft = {"name": "../escape", "seed": 0, "faults": []}
    with TestClient(app) as client:
        assert client.post("/profiles", json=draft).status_code == 400


def test_save_invalid_draft_is_422(tmp_profiles):
    draft = {"name": "broken", "seed": 0, "faults": [{"type": "timeout", "probability": 0.5}]}
    with TestClient(app) as client:
        assert client.post("/profiles", json=draft).status_code == 422


def test_delete_custom_profile(tmp_profiles):
    draft = {"name": "tmp_one", "seed": 1, "faults": []}
    with TestClient(app) as client:
        client.post("/profiles", json=draft)
        assert (tmp_profiles / "tmp_one.yaml").exists()
        assert client.delete("/profiles/tmp_one").status_code == 204
        assert not (tmp_profiles / "tmp_one.yaml").exists()


def test_delete_builtin_is_400(tmp_profiles):
    with TestClient(app) as client:
        assert client.delete("/profiles/hell_mode").status_code == 400


def test_delete_unknown_profile_is_404(tmp_profiles):
    with TestClient(app) as client:
        assert client.delete("/profiles/nope").status_code == 404


# ---------------------------------------------------------------------------
# PUT /targets/{name} + oracle-config validation
# ---------------------------------------------------------------------------


@pytest.fixture()
def http_targets(monkeypatch, tmp_path):
    import saboteur.api.targets as targets_mod

    monkeypatch.setattr(
        targets_mod, "_store", TargetStore(Database(tmp_path / "saboteur.db"))
    )


def test_put_updates_existing_target(http_targets):
    with TestClient(app) as client:
        client.post(
            "/targets",
            json={"name": "byo", "kind": "command", "cmd": ["python", "old.py"]},
        )
        updated = client.put(
            "/targets/byo",
            json={"name": "byo", "kind": "command", "cmd": ["python", "new.py"]},
        )
        assert updated.status_code == 200
        assert updated.json()["cmd"] == ["python", "new.py"]
        # Path name is authoritative: a mismatched body name does not rename.
        got = {t["name"]: t for t in client.get("/targets").json()}
        assert got["byo"]["cmd"] == ["python", "new.py"]


def test_put_unknown_target_is_404(http_targets):
    with TestClient(app) as client:
        resp = client.put(
            "/targets/ghost",
            json={"name": "ghost", "kind": "command", "cmd": ["x"]},
        )
        assert resp.status_code == 404


def test_put_reference_is_400(http_targets):
    with TestClient(app) as client:
        resp = client.put(
            "/targets/reference",
            json={"name": "reference", "kind": "command", "cmd": ["x"]},
        )
        assert resp.status_code == 400


def test_create_and_update_reject_bad_oracle(http_targets):
    bad = {
        "name": "byo",
        "kind": "command",
        "cmd": ["python", "a.py"],
        "oracle": {"kind": "regex"},  # missing 'pattern'
    }
    with TestClient(app) as client:
        # Create with a bad oracle config → 400.
        assert client.post("/targets", json=bad).status_code == 400
        # A valid create, then a bad-oracle edit → 400.
        good = {**bad, "oracle": {"kind": "regex", "pattern": "ANSWER"}}
        assert client.post("/targets", json=good).status_code == 201
        assert client.put("/targets/byo", json=bad).status_code == 400
