
from __future__ import annotations

import re
from pathlib import Path

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ValidationError

from saboteur.chaos.profile import ChaosProfile, load_profile

router = APIRouter(prefix="/profiles", tags=["profiles"])

_PROFILES_DIR = Path("profiles")

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

BUILTIN_PROFILES = frozenset(
    {"calm_seas", "flaky_friday", "rate_limit_storm", "hell_mode", "liars_den"}
)


class FaultSummary(BaseModel):
    type: str
    probability: float


class ProfileInfo(BaseModel):
    name: str
    description: str
    seed: int
    faults: list[FaultSummary]


class ProfileDraft(BaseModel):
    name: str
    seed: int = 0
    description: str = ""
    faults: list[dict] = []


class ValidationItem(BaseModel):
    loc: str
    msg: str


class ValidationResult(BaseModel):
    valid: bool
    errors: list[ValidationItem]


def _info(profile: ChaosProfile) -> ProfileInfo:
    return ProfileInfo(
        name=profile.name,
        description=profile.description,
        seed=profile.seed,
        faults=[
            FaultSummary(type=str(f.type), probability=f.probability)
            for f in profile.faults
        ],
    )


def _validate(draft: ProfileDraft) -> tuple[ChaosProfile | None, list[ValidationItem]]:
    try:
        profile = ChaosProfile.model_validate(draft.model_dump())
        return profile, []
    except ValidationError as exc:
        errors = [
            ValidationItem(
                loc=".".join(str(loc) for loc in err["loc"]) or "<root>",
                msg=err["msg"],
            )
            for err in exc.errors()
        ]
        return None, errors


@router.get("", response_model=list[ProfileInfo])
def list_profiles() -> list[ProfileInfo]:
    paths = sorted(_PROFILES_DIR.glob("*.yaml"))
    if not paths:
        raise HTTPException(404, "no profiles found")
    return [_info(load_profile(path)) for path in paths]


@router.get("/{name}", response_model=ChaosProfile)
def get_profile(name: str) -> ChaosProfile:
    if not _NAME_RE.match(name):
        raise HTTPException(400, f"invalid profile name {name!r}")
    path = _PROFILES_DIR / f"{name}.yaml"
    if not path.exists():
        raise HTTPException(404, f"profile '{name}' not found")
    return load_profile(path)


@router.post("/validate", response_model=ValidationResult)
def validate_profile(draft: ProfileDraft) -> ValidationResult:
    _, errors = _validate(draft)
    return ValidationResult(valid=not errors, errors=errors)


@router.post("", response_model=ProfileInfo, status_code=201)
def save_profile(draft: ProfileDraft) -> ProfileInfo:
    if not _NAME_RE.match(draft.name):
        raise HTTPException(
            400, f"profile name {draft.name!r} must match [A-Za-z0-9_-]+"
        )
    if draft.name in BUILTIN_PROFILES:
        raise HTTPException(
            409, f"'{draft.name}' is a built-in profile and cannot be overwritten"
        )
    profile, errors = _validate(draft)
    if profile is None:
        raise HTTPException(
            422, "; ".join(f"{e.loc}: {e.msg}" for e in errors)
        )

    _PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "name": profile.name,
        "seed": profile.seed,
        "description": profile.description,
        "faults": [
            f.model_dump(exclude_defaults=True, mode="json") for f in profile.faults
        ],
    }
    path = _PROFILES_DIR / f"{profile.name}.yaml"
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return _info(profile)


@router.delete("/{name}", status_code=204)
def delete_profile(name: str) -> None:
    if name in BUILTIN_PROFILES:
        raise HTTPException(400, f"'{name}' is a built-in profile and cannot be deleted")
    if not _NAME_RE.match(name):
        raise HTTPException(400, f"invalid profile name {name!r}")
    path = _PROFILES_DIR / f"{name}.yaml"
    if not path.exists():
        raise HTTPException(404, f"profile '{name}' not found")
    path.unlink()
