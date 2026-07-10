# chaos profile schema and yaml loader

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .events import FaultType

Range = tuple[float, float]

# required fields per fault type
_REQUIRED_PARAMS: dict[FaultType, tuple[str, ...]] = {
    FaultType.RATE_LIMIT: ("retry_after_s",),
    FaultType.LATENCY: ("delay_s",),
    FaultType.TIMEOUT: ("timeout_after_s",),
    FaultType.CONTEXT_DROP: ("drop_last_k",),
}

# relevant params per fault type for validation and profile building
FAULT_PARAMS: dict[FaultType, tuple[str, ...]] = {
    FaultType.API_ERROR: ("status_codes",),
    FaultType.RATE_LIMIT: ("retry_after_s", "burst_budget", "window_calls"),
    FaultType.MALFORMED: (),
    FaultType.SILENT_LIE: ("lie_offset", "lie_factor"),
    FaultType.TOOL_VANISH: (),
    FaultType.LATENCY: ("delay_s",),
    FaultType.TIMEOUT: ("timeout_after_s",),
    FaultType.CONTEXT_DROP: ("drop_last_k",),
}


class FaultSpec(BaseModel):
    # one fault entry in a chaos profile

    model_config = ConfigDict(extra="forbid")

    type: FaultType
    probability: float = Field(ge=0.0, le=1.0)
    target_tools: list[str] | None = None  # None applies to all tools

    # --- rate_limit ---
    retry_after_s: Range | None = None
    # burst budget limits calls per window of consecutive calls
    burst_budget: int | None = Field(default=None, ge=1)
    window_calls: int | None = Field(default=None, ge=1)

    # --- latency / timeout ---
    delay_s: Range | None = None
    timeout_after_s: float | None = Field(default=None, gt=0)

    # --- context_drop ---
    drop_last_k: int | None = Field(default=None, ge=1)

    # --- api_error ---
    status_codes: tuple[int, ...] = (500, 503)

    # --- silent_lie ---
    lie_offset: Range = (10.0, 30.0)  # additive temperature offset
    lie_factor: Range = (1.5, 3.0)  # multiplicative calculator factor

    @model_validator(mode="after")
    def _check_params(self) -> "FaultSpec":
        for field_name in _REQUIRED_PARAMS.get(self.type, ()):
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"fault '{self.type}' requires field '{field_name}'"
                )
        if (self.burst_budget is None) != (self.window_calls is None):
            raise ValueError(
                f"fault '{self.type}': fields 'burst_budget' and "
                "'window_calls' must be set together"
            )
        for field_name in ("retry_after_s", "delay_s", "lie_offset", "lie_factor"):
            bounds: Range | None = getattr(self, field_name)
            if bounds is not None and bounds[0] > bounds[1]:
                raise ValueError(
                    f"fault '{self.type}': field '{field_name}' must be "
                    f"[low, high] with low <= high, got {list(bounds)}"
                )
        return self


class ChaosProfile(BaseModel):
    # a named, seeded chaos profile

    model_config = ConfigDict(extra="forbid")

    name: str
    seed: int
    description: str = ""
    faults: list[FaultSpec] = Field(default_factory=list)


def load_profile(path: str | Path) -> ChaosProfile:
    """Load and validate a chaos profile from a YAML file.

    Raises ``ValueError`` naming the file and offending field(s) if the
    YAML does not match the schema.
    """
    p = Path(path)
    raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    try:
        return ChaosProfile.model_validate(raw)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
            for err in exc.errors()
        )
        raise ValueError(f"invalid chaos profile {p}: {problems}") from exc
