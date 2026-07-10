#!/usr/bin/env python
# Usage: python scripts/demo_chaos.py

from __future__ import annotations

import json
from pathlib import Path

from saboteur.chaos import ChaosEngine, ChaosProfile, FaultEvent, load_profile

REPO_ROOT = Path(__file__).resolve().parents[1]


def fast_hell_mode() -> ChaosProfile:
    # hell_mode with sleeps shrunk to milliseconds so the demo is instant.
    profile = load_profile(REPO_ROOT / "profiles" / "hell_mode.yaml")
    faults = []
    for spec in profile.faults:
        update: dict = {}
        if spec.delay_s is not None:
            update["delay_s"] = (0.001, 0.005)
        if spec.timeout_after_s is not None:
            update["timeout_after_s"] = 0.005
        faults.append(spec.model_copy(update=update) if update else spec)
    return profile.model_copy(update={"faults": faults})


def run_agent(profile: ChaosProfile, agent_id: int, n_calls: int = 30) -> list[str]:
    lines: list[str] = []
    call_faults: list[FaultEvent] = []
    engine = ChaosEngine(profile, agent_id, on_fault=call_faults.append)
    tools = engine.wrap_tools(
        {
            "get_weather": lambda city: json.dumps({"city": city, "temp_c": 22.0}),
            "calculator": lambda expr: "71.6",
        }
    )
    for i in range(n_calls):
        call_faults.clear()
        name = "get_weather" if i % 2 == 0 else "calculator"
        arg = "Tokyo" if i % 2 == 0 else "22.0 * 9 / 5 + 32"
        try:
            result = tools[name](arg)
        except Exception as exc:
            outcome = f"RAISED {type(exc).__name__}: {exc}"
        else:
            outcome = f"ok -> {result!r}"
        faults = ", ".join(str(e.fault) for e in call_faults) or "none"
        lines.append(f"  call {i:02d} {name:<12} faults=[{faults:<24}] {outcome}")
    return lines


def main() -> None:
    profile = fast_hell_mode()
    print(f"profile={profile.name} seed={profile.seed} (sleeps scaled to ms)\n")

    runs: dict[str, list[str]] = {}
    for label, agent_id in [("agent 0", 0), ("agent 1", 1), ("agent 0 (rerun)", 0)]:
        print(f"=== {label} ===")
        lines = run_agent(profile, agent_id)
        print("\n".join(lines), end="\n\n")
        runs[label] = lines

    identical = runs["agent 0"] == runs["agent 0 (rerun)"]
    different = runs["agent 0"] != runs["agent 1"]
    print(f"agent 0 rerun identical to first run: {identical}")
    print(f"agent 1 differs from agent 0:        {different}")
    if not (identical and different):
        raise SystemExit("DETERMINISM VIOLATION — invariant #1 broken")
    print("determinism holds (invariant #1).")


if __name__ == "__main__":
    main()
