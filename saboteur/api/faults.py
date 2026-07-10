
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from saboteur.chaos.events import LAYER, FaultType
from saboteur.chaos.profile import (
    FAULT_PARAMS,
    _REQUIRED_PARAMS,
    FaultSpec,
)

router = APIRouter(tags=["faults"])

_PARAM_KIND: dict[str, str] = {
    "status_codes": "int_list",
    "retry_after_s": "range",
    "burst_budget": "int",
    "window_calls": "int",
    "lie_offset": "range",
    "lie_factor": "range",
    "delay_s": "range",
    "timeout_after_s": "float",
    "drop_last_k": "int",
}

_SUGGESTED_DEFAULT: dict[str, object] = {
    "retry_after_s": [2.0, 8.0],
    "burst_budget": 2,
    "window_calls": 5,
    "delay_s": [1.0, 4.0],
    "timeout_after_s": 30.0,
    "drop_last_k": 1,
}


class ParamSpec(BaseModel):
    name: str
    kind: str
    required: bool
    default: object | None


class FaultCatalogEntry(BaseModel):
    type: str
    layer: str
    required: list[str]
    params: list[ParamSpec]


def _default_for(name: str) -> object | None:
    field = FaultSpec.model_fields.get(name)
    if field is not None and field.default is not None:
        default = field.default
        # format tuples as json lists
        if isinstance(default, tuple):
            return list(default)
        return default
    return _SUGGESTED_DEFAULT.get(name)


@router.get("/faults", response_model=list[FaultCatalogEntry])
def list_faults() -> list[FaultCatalogEntry]:
    catalog: list[FaultCatalogEntry] = []
    for ft in FaultType:
        required = _REQUIRED_PARAMS.get(ft, ())
        params = [
            ParamSpec(
                name=name,
                kind=_PARAM_KIND[name],
                required=name in required,
                default=_default_for(name),
            )
            for name in FAULT_PARAMS.get(ft, ())
        ]
        catalog.append(
            FaultCatalogEntry(
                type=str(ft),
                layer=LAYER[ft],
                required=list(required),
                params=params,
            )
        )
    return catalog
