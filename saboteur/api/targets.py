"""Target registry routes — register the BYO agents a cohort can run.

- ``GET    /targets``        — list targets (built-in ``reference`` first).
- ``POST   /targets``        — register a ``command`` target → 201.
- ``PUT    /targets/{name}`` — update an existing ``command`` target → 200.
- ``DELETE /targets/{name}`` — remove a stored target → 204.

The store is the ``targets`` table of the SQLite index
(:mod:`saboteur.storage.db`); the built-in ``reference`` target is implicit
(never stored, never deletable). ``_store`` is the test seam:
``monkeypatch.setattr(targets_mod, "_store", TargetStore(Database(tmp_path)))``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from saboteur.harness.targets import (
    Target,
    TargetExistsError,
    TargetNotFoundError,
    target_store,
)

router = APIRouter(prefix="/targets", tags=["targets"])

# Override in tests to redirect the JSON store to a temp path.
_store = target_store


@router.get("", response_model=list[Target])
def list_targets() -> list[Target]:
    """All known targets, reference first."""
    return _store.all()


@router.post("", response_model=Target, status_code=201)
def create_target(target: Target) -> Target:
    """Register a command target (409 on duplicate, 400 on invalid spec/oracle)."""
    try:
        return _store.add(target)
    except TargetExistsError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/{name}", response_model=Target)
def update_target(name: str, target: Target) -> Target:
    """Update an existing command target (404 unknown, 400 invalid spec/oracle).

    The path ``name`` is authoritative — it overrides the body's name so a target
    cannot be renamed (and silently orphaned) via an edit.
    """
    if name == "reference":
        raise HTTPException(400, "'reference' is built-in and cannot be edited")
    edited = target.model_copy(update={"name": name})
    try:
        return _store.update(edited)
    except TargetNotFoundError as exc:
        raise HTTPException(404, f"target {name!r} not found") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/{name}", status_code=204)
def delete_target(name: str) -> None:
    """Delete a stored command target (404 unknown, 400 on reference)."""
    if name == "reference":
        raise HTTPException(400, "'reference' is built-in and cannot be deleted")
    try:
        _store.delete(name)
    except TargetNotFoundError as exc:
        raise HTTPException(404, f"target {name!r} not found") from exc
