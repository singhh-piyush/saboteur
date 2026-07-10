
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from saboteur.harness.targets import (
    Target,
    TargetExistsError,
    TargetNotFoundError,
    target_store,
)

router = APIRouter(prefix="/targets", tags=["targets"])

_store = target_store


@router.get("", response_model=list[Target])
def list_targets() -> list[Target]:
    return _store.all()


@router.post("", response_model=Target, status_code=201)
def create_target(target: Target) -> Target:
    try:
        return _store.add(target)
    except TargetExistsError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/{name}", response_model=Target)
def update_target(name: str, target: Target) -> Target:
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
    if name == "reference":
        raise HTTPException(400, "'reference' is built-in and cannot be deleted")
    try:
        _store.delete(name)
    except TargetNotFoundError as exc:
        raise HTTPException(404, f"target {name!r} not found") from exc
