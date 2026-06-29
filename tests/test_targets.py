"""Target registry tests — LLM-free, SQLite store on a temp path.

Covers the :class:`TargetStore` CRUD contract (reference is built-in + never
deletable), the ``build_oracle`` mapping, and the ``/targets`` HTTP routes.
The registry now lives in the SQLite index (``targets`` table) — tests point a
:class:`Database` at a temp file for isolation.
"""

from __future__ import annotations

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
from saboteur.storage.db import Database


def _cmd(name: str = "byo") -> Target:
    return Target(name=name, kind="command", cmd=["python", "-c", "print('hi')"])


def _store(tmp_path) -> TargetStore:
    return TargetStore(Database(tmp_path / "saboteur.db"))


# ---------------------------------------------------------------------------
# TargetStore CRUD
# ---------------------------------------------------------------------------


def test_reference_always_present_and_first(tmp_path):
    store = _store(tmp_path)
    listed = store.all()
    assert listed[0].name == "reference"
    assert listed[0].kind == "reference"
    assert store.get("reference") is not None


def test_add_get_delete_roundtrip_persists(tmp_path):
    dbpath = tmp_path / "saboteur.db"
    store = TargetStore(Database(dbpath))
    store.add(_cmd("byo"))

    # Persisted to the DB and visible through a fresh store on the same file.
    again = TargetStore(Database(dbpath))
    got = again.get("byo")
    assert got is not None and got.cmd == ["python", "-c", "print('hi')"]
    assert [t.name for t in again.all()] == ["reference", "byo"]

    again.delete("byo")
    assert again.get("byo") is None
    assert [t.name for t in TargetStore(Database(dbpath)).all()] == ["reference"]


def test_add_rejects_reserved_and_duplicate_and_invalid(tmp_path):
    store = _store(tmp_path)
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
    store = _store(tmp_path)
    with pytest.raises(TargetNotFoundError):
        store.delete("nope")
    with pytest.raises(TargetNotFoundError):
        store.delete("reference")


def test_corrupt_store_skips_bad_row(tmp_path):
    database = Database(tmp_path / "saboteur.db")
    database.target_upsert("bad", {"name": "bad"})  # not a valid Target (no kind)
    store = TargetStore(database)
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

    monkeypatch.setattr(
        targets_mod, "_store", TargetStore(Database(tmp_path / "saboteur.db"))
    )


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


def test_store_persists_to_db_row(tmp_path):
    database = Database(tmp_path / "saboteur.db")
    TargetStore(database).add(_cmd("byo"))
    stored = database.target_get("byo")
    assert stored is not None and stored["name"] == "byo"
    assert "byo" in {t["name"] for t in database.targets_all()}
