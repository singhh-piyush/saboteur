"""Target registry tests — LLM-free, JSON store on a temp path.

Covers the :class:`TargetStore` CRUD contract (reference is built-in + never
deletable), the ``build_oracle`` mapping, and the ``/targets`` HTTP routes.
"""

from __future__ import annotations

import json

import pytest

from saboteur.agents.oracle import (
    AssertionCommandOracle,
    HttpCallbackOracle,
    RegexOracle,
)
from saboteur.harness.targets import (
    OracleConfig,
    Target,
    TargetExistsError,
    TargetNotFoundError,
    TargetStore,
    build_oracle,
)


def _cmd(name: str = "byo") -> Target:
    return Target(name=name, kind="command", cmd=["python", "-c", "print('hi')"])


# ---------------------------------------------------------------------------
# TargetStore CRUD
# ---------------------------------------------------------------------------


def test_reference_always_present_and_first(tmp_path):
    store = TargetStore(tmp_path / "targets.json")
    listed = store.all()
    assert listed[0].name == "reference"
    assert listed[0].kind == "reference"
    assert store.get("reference") is not None


def test_add_get_delete_roundtrip_persists(tmp_path):
    path = tmp_path / "targets.json"
    store = TargetStore(path)
    store.add(_cmd("byo"))

    # Persisted to disk and visible through a fresh store instance.
    again = TargetStore(path)
    got = again.get("byo")
    assert got is not None and got.cmd == ["python", "-c", "print('hi')"]
    assert [t.name for t in again.all()] == ["reference", "byo"]

    again.delete("byo")
    assert again.get("byo") is None
    assert [t.name for t in TargetStore(path).all()] == ["reference"]


def test_add_rejects_reserved_and_duplicate_and_invalid(tmp_path):
    store = TargetStore(tmp_path / "targets.json")
    store.add(_cmd("byo"))

    with pytest.raises(TargetExistsError):
        store.add(_cmd("byo"))  # duplicate
    with pytest.raises(TargetExistsError):
        store.add(Target(name="reference", kind="command", cmd=["x"]))  # reserved
    with pytest.raises(ValueError):
        store.add(Target(name="no_cmd", kind="command"))  # missing cmd
    with pytest.raises(ValueError):
        store.add(Target(name="bad name", kind="command", cmd=["x"]))  # bad chars


def test_delete_unknown_and_reference_raise(tmp_path):
    store = TargetStore(tmp_path / "targets.json")
    with pytest.raises(TargetNotFoundError):
        store.delete("nope")
    with pytest.raises(TargetNotFoundError):
        store.delete("reference")


def test_corrupt_store_reads_as_empty(tmp_path):
    path = tmp_path / "targets.json"
    path.write_text("{ this is not json", encoding="utf-8")
    store = TargetStore(path)
    assert [t.name for t in store.all()] == ["reference"]  # only the built-in


# ---------------------------------------------------------------------------
# build_oracle mapping
# ---------------------------------------------------------------------------


def test_build_oracle_mapping():
    assert build_oracle(OracleConfig(kind="none")) is None
    assert isinstance(build_oracle(OracleConfig(kind="regex", pattern="x")), RegexOracle)
    assert isinstance(
        build_oracle(OracleConfig(kind="command", command="true")),
        AssertionCommandOracle,
    )
    assert isinstance(
        build_oracle(OracleConfig(kind="http", url="http://x")), HttpCallbackOracle
    )


def test_build_oracle_requires_fields():
    for cfg in (
        OracleConfig(kind="regex"),
        OracleConfig(kind="command"),
        OracleConfig(kind="http"),
    ):
        with pytest.raises(ValueError):
            build_oracle(cfg)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


@pytest.fixture()
def http_targets(monkeypatch, tmp_path):
    import saboteur.api.targets as targets_mod

    monkeypatch.setattr(targets_mod, "_store", TargetStore(tmp_path / "targets.json"))


def test_targets_routes_crud(http_targets):
    from starlette.testclient import TestClient

    from saboteur.api import app

    with TestClient(app) as client:
        # Initially just the reference target.
        listed = client.get("/targets").json()
        assert [t["name"] for t in listed] == ["reference"]

        created = client.post(
            "/targets",
            json={"name": "byo", "kind": "command", "cmd": ["python", "-c", "pass"]},
        )
        assert created.status_code == 201
        assert created.json()["name"] == "byo"

        names = [t["name"] for t in client.get("/targets").json()]
        assert names == ["reference", "byo"]

        # Duplicate → 409.
        dup = client.post(
            "/targets",
            json={"name": "byo", "kind": "command", "cmd": ["python"]},
        )
        assert dup.status_code == 409

        # Deleting reference → 400; unknown → 404.
        assert client.delete("/targets/reference").status_code == 400
        assert client.delete("/targets/nope").status_code == 404

        # Delete the real one → 204, then gone.
        assert client.delete("/targets/byo").status_code == 204
        assert [t["name"] for t in client.get("/targets").json()] == ["reference"]


def test_post_target_invalid_kind_is_400(http_targets):
    from starlette.testclient import TestClient

    from saboteur.api import app

    with TestClient(app) as client:
        resp = client.post("/targets", json={"name": "ref2", "kind": "reference"})
        assert resp.status_code == 400


def test_store_file_shape(tmp_path):
    path = tmp_path / "targets.json"
    TargetStore(path).add(_cmd("byo"))
    data = json.loads(path.read_text())
    assert "targets" in data and data["targets"][0]["name"] == "byo"
