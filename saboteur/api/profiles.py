"""GET /profiles — list available chaos profiles with fault summaries."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from saboteur.chaos.profile import load_profile

router = APIRouter(prefix="/profiles", tags=["profiles"])

_PROFILES_DIR = Path("profiles")


class FaultSummary(BaseModel):
    type: str
    probability: float


class ProfileInfo(BaseModel):
    name: str
    description: str
    seed: int
    faults: list[FaultSummary]


@router.get("", response_model=list[ProfileInfo])
def list_profiles() -> list[ProfileInfo]:
    paths = sorted(_PROFILES_DIR.glob("*.yaml"))
    if not paths:
        raise HTTPException(404, "no profiles found")
    result = []
    for path in paths:
        profile = load_profile(path)
        result.append(
            ProfileInfo(
                name=profile.name,
                description=profile.description,
                seed=profile.seed,
                faults=[
                    FaultSummary(type=str(f.type), probability=f.probability)
                    for f in profile.faults
                ],
            )
        )
    return result
