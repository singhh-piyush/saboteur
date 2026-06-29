"""GET /faults — the fault taxonomy catalog that drives the Profile Builder.

The dashboard's Profile Builder renders one editable form per fault from this
catalog instead of hard-coding the field set, so the UI can never drift from the
Python schema. The catalog is derived from the chaos package's single sources of
truth: :class:`~saboteur.chaos.events.FaultType` (the 8 faults), ``LAYER`` (their
3 layers), ``_REQUIRED_PARAMS`` / ``FAULT_PARAMS`` (which params apply to which
fault), and ``FaultSpec`` field defaults.

Read-only; no new dependencies.
"""

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

# How each FaultSpec param is edited in the UI (mirrors the FaultSpec field
# types). ``range`` = an inclusive [low, high] pair; ``int_list`` = a list of
# ints (e.g. HTTP status codes). Suggested defaults seed a fresh fault so the
# form starts schema-valid even for required params FaultSpec leaves ``None``.
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

# Seeds for params FaultSpec defaults to ``None`` (the required knobs). Params
# with a real FaultSpec default (status_codes, lie_offset, lie_factor) take it.
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
    kind: str  # range | int | float | int_list
    required: bool
    default: object | None


class FaultCatalogEntry(BaseModel):
    type: str
    layer: str  # tool | transport | context
    required: list[str]
    params: list[ParamSpec]


def _default_for(name: str) -> object | None:
    """A sensible starting value for *name* — the FaultSpec default if it has a
    concrete one, else the suggested seed for a required-but-None knob."""
    field = FaultSpec.model_fields.get(name)
    if field is not None and field.default is not None:
        default = field.default
        # Normalize tuples (Range / status_codes) to JSON-friendly lists.
        if isinstance(default, tuple):
            return list(default)
        return default
    return _SUGGESTED_DEFAULT.get(name)


@router.get("/faults", response_model=list[FaultCatalogEntry])
def list_faults() -> list[FaultCatalogEntry]:
    """The 8 faults with their layer, required params, and editable params.

    ``probability`` (float 0-1) and ``target_tools`` (optional string list) are
    common to every fault and are handled by the builder directly, not listed
    here.
    """
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
