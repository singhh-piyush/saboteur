"""Determinism + chaos-engine behavior tests.

Sleep-based faults use sub-millisecond
delays so the suite stays fast.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from saboteur.chaos import (
    ChaosEngine,
    ChaosProfile,
    FaultEvent,
    FaultSpec,
    FaultType,
    SimulatedRateLimit,
    ToolVanishedError,
    load_profile,
)

PROFILES_DIR = Path(__file__).resolve().parents[1] / "profiles"
PROFILE_NAMES = ["calm_seas", "flaky_friday", "rate_limit_storm", "hell_mode"]


def _spicy_profile(seed: int = 42) -> ChaosProfile:
    # A profile exercising all tool/transport faults with tiny sleeps.
    return ChaosProfile(
        name="test_spicy",
        seed=seed,
        faults=[
            FaultSpec(type=FaultType.API_ERROR, probability=0.20),
            FaultSpec(
                type=FaultType.RATE_LIMIT, probability=0.15, retry_after_s=(1, 8)
            ),
            FaultSpec(type=FaultType.MALFORMED, probability=0.10),
            FaultSpec(type=FaultType.SILENT_LIE, probability=0.15),
            FaultSpec(type=FaultType.TOOL_VANISH, probability=0.02),
            FaultSpec(
                type=FaultType.LATENCY, probability=0.20, delay_s=(0.0, 0.001)
            ),
            FaultSpec(
                type=FaultType.TIMEOUT, probability=0.05, timeout_after_s=0.001
            ),
        ],
    )


def _run_sequence(profile: ChaosProfile, agent_id: int, n: int = 200) -> bytes:
    # Run n simulated tool calls and serialize everything observable.
    records: list[str] = []

    def on_fault(event: FaultEvent) -> None:
        records.append(
            f"fault idx={event.call_index} {event.fault} tool={event.tool_name} "
            f"detail={sorted(event.detail.items())}"
        )

    engine = ChaosEngine(profile, agent_id, on_fault=on_fault)
    tools = engine.wrap_tools(
        {
            "get_weather": lambda city: json.dumps({"city": city, "temp_c": 22.0}),
            "calculator": lambda expr: "71.6",
        }
    )
    for i in range(n):
        name = "get_weather" if i % 2 == 0 else "calculator"
        arg = "Tokyo" if i % 2 == 0 else "22.0 * 9 / 5 + 32"
        try:
            result = tools[name](arg)
        except Exception as exc:
            records.append(f"call {i} exc {type(exc).__name__}: {exc}")
        else:
            records.append(f"call {i} ok {result!r}")
    return "\n".join(records).encode()


def test_same_seed_same_agent_identical_sequence() -> None:
    seq_a = _run_sequence(_spicy_profile(), agent_id=3)
    seq_b = _run_sequence(_spicy_profile(), agent_id=3)
    assert seq_a == seq_b

    assert b"fault" in seq_a


def test_different_agent_ids_different_sequences() -> None:
    assert _run_sequence(_spicy_profile(), agent_id=0) != _run_sequence(
        _spicy_profile(), agent_id=1
    )


def test_different_seeds_different_sequences() -> None:
    assert _run_sequence(_spicy_profile(seed=1), agent_id=0) != _run_sequence(
        _spicy_profile(seed=2), agent_id=0
    )


def test_calm_seas_injects_zero_faults() -> None:
    profile = load_profile(PROFILES_DIR / "calm_seas.yaml")
    events: list[FaultEvent] = []
    engine = ChaosEngine(profile, agent_id=0, on_fault=events.append)
    tool = engine.wrap("get_weather", lambda city: f"{city}: 22.0 C")
    results = [tool("Tokyo") for _ in range(200)]
    assert events == []
    assert results == ["Tokyo: 22.0 C"] * 200


def test_rate_limit_honors_rolling_budget() -> None:
    # With probability 0, only the call-count budget can trigger 429s.
    profile = ChaosProfile(
        name="budget_only",
        seed=7,
        faults=[
            FaultSpec(
                type=FaultType.RATE_LIMIT,
                probability=0.0,
                retry_after_s=(1, 1),
                burst_budget=2,
                window_calls=5,
            )
        ],
    )
    engine = ChaosEngine(profile, agent_id=0)
    tool = engine.wrap("api", lambda: "ok")
    outcomes = []
    for _ in range(7):
        try:
            tool()
            outcomes.append("ok")
        except SimulatedRateLimit as exc:
            assert exc.retry_after_s == 1.0
            outcomes.append("429")
    assert outcomes == ["ok", "ok", "429", "429", "429", "429", "ok"]


def test_tool_vanish_is_sticky() -> None:
    profile = ChaosProfile(
        name="vanish",
        seed=0,
        faults=[FaultSpec(type=FaultType.TOOL_VANISH, probability=1.0)],
    )
    events: list[FaultEvent] = []
    engine = ChaosEngine(profile, agent_id=0, on_fault=events.append)
    tool = engine.wrap("web_search", lambda q: "results")
    for _ in range(5):
        with pytest.raises(ToolVanishedError):
            tool("query")
    assert [e.detail["sticky"] for e in events] == [False, True, True, True, True]


def test_silent_lie_is_wrong_but_well_formed() -> None:
    profile = ChaosProfile(
        name="liar",
        seed=11,
        faults=[FaultSpec(type=FaultType.SILENT_LIE, probability=1.0)],
    )
    engine = ChaosEngine(profile, agent_id=0)
    weather = engine.wrap(
        "get_weather", lambda city: json.dumps({"city": city, "temp_c": 22.0})
    )
    calc = engine.wrap("calculator", lambda expr: 71.6)

    lied_weather = json.loads(weather("Tokyo"))
    assert lied_weather["city"] == "Tokyo"
    assert lied_weather["temp_c"] != 22.0
    # Temperature-style first-number lie: off by 10-30 degrees.
    assert 10 <= abs(lied_weather["temp_c"] - 22.0) <= 30

    lied_calc = calc("22.0 * 9 / 5 + 32")
    assert isinstance(lied_calc, float)
    assert lied_calc != 71.6


def test_target_tools_scopes_faults() -> None:
    profile = ChaosProfile(
        name="scoped",
        seed=5,
        faults=[
            FaultSpec(
                type=FaultType.API_ERROR, probability=1.0, target_tools=["web_search"]
            )
        ],
    )
    engine = ChaosEngine(profile, agent_id=0)
    tools = engine.wrap_tools(
        {"web_search": lambda q: "hits", "file_report": lambda r: "filed"}
    )
    assert tools["file_report"]("done") == "filed"
    with pytest.raises(Exception, match="simulated upstream API error"):
        tools["web_search"]("query")


def test_context_drop_trims_memory_but_keeps_task() -> None:
    TaskStep = type("TaskStep", (), {})  # matched by type name, like smolagents'

    class FakeMemory:
        def __init__(self) -> None:
            self.steps = [TaskStep(), "step1", "step2", "step3"]

    class FakeAgent:
        def __init__(self) -> None:
            self.memory = FakeMemory()

    profile = ChaosProfile(
        name="amnesia",
        seed=0,
        faults=[

            FaultSpec(type=FaultType.CONTEXT_DROP, probability=1.0, drop_last_k=5)
        ],
    )
    events: list[FaultEvent] = []
    engine = ChaosEngine(profile, agent_id=0, on_fault=events.append)

    agent = FakeAgent()
    engine.step_hook(agent)
    assert [type(s).__name__ for s in agent.memory.steps] == ["TaskStep"]
    assert events[0].fault is FaultType.CONTEXT_DROP
    assert events[0].detail == {"dropped_steps": 3}


    engine.step_hook(object())


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_shipped_profiles_load(name: str) -> None:
    profile = load_profile(PROFILES_DIR / f"{name}.yaml")
    assert profile.name == name


def test_hell_mode_covers_all_eight_faults() -> None:
    profile = load_profile(PROFILES_DIR / "hell_mode.yaml")
    assert {spec.type for spec in profile.faults} == set(FaultType)


def test_invalid_profile_names_offending_field(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "name: bad\nseed: 1\nfaults:\n  - type: rate_limit\n    probability: 0.5\n"
    )
    with pytest.raises(ValueError, match="retry_after_s"):
        load_profile(bad)


def test_unknown_profile_field_is_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "typo.yaml"
    bad.write_text(
        "name: typo\nseed: 1\nfaults:\n"
        "  - type: latency\n    probability: 0.5\n    delay_seconds: [1, 2]\n"
    )
    with pytest.raises(ValueError, match="delay_seconds"):
        load_profile(bad)
