"""BYO cohort spawner tests — real (but trivial) subprocesses.

The agent source is replaced by tiny ``python -c`` / script subprocesses that
never touch the proxy wire, so we can exercise the spawner's contract
directly: env wiring, per-agent terminal outcomes, crash isolation, the
wall-clock kill, the oracle freeze, and replay parity. Each test uses a unique
run id (the proxy ``manager`` + ``run_registry`` are module singletons).
"""

from __future__ import annotations

import json
import sys
import uuid

from saboteur.chaos.profile import ChaosProfile, FaultSpec
from saboteur.config import get_settings
from saboteur.harness.scoring import Scorecard, score
from saboteur.harness.spawn import run_byo_cohort
from saboteur.harness.targets import OracleConfig, Target
from saboteur.proxy.session import manager
from saboteur.telemetry.jsonl import read_jsonl
from saboteur.telemetry.schema import TelemetryEvent


def _rid(name: str) -> str:
    return f"{name}-{uuid.uuid4().hex[:8]}"


def _profile(*faults: dict, seed: int = 7) -> ChaosProfile:
    return ChaosProfile(name="probe", seed=seed, faults=[FaultSpec(**f) for f in faults])


def _target(cmd: list[str], *, env: dict | None = None, oracle: OracleConfig | None = None) -> Target:
    return Target(
        name="byo",
        kind="command",
        cmd=cmd,
        env=env or {},
        oracle=oracle or OracleConfig(),
    )


def _done(run, agent_id: int) -> TelemetryEvent:
    return next(
        e for e in run.events if e.event == "agent_done" and e.agent_id == agent_id
    )


_PRINT_OK = [sys.executable, "-c", "print('ANSWER: 71.6')"]
_CRASH = [sys.executable, "-c", "import sys; sys.exit(1)"]


# ---------------------------------------------------------------------------
# Env wiring
# ---------------------------------------------------------------------------


async def test_env_wiring(tmp_path):
    outdir = tmp_path / "out"
    outdir.mkdir()
    script = tmp_path / "dump.py"
    script.write_text(
        "import json, os\n"
        f"out = os.path.join({str(outdir)!r}, 'env_' + os.environ['SABOTEUR_AGENT_ID'] + '.json')\n"
        "keys = ['OPENAI_BASE_URL','SABOTEUR_RUN_ID','SABOTEUR_AGENT_ID','MODEL_ID','EXTRA','OPENAI_API_KEY']\n"
        "json.dump({k: os.environ.get(k) for k in keys}, open(out, 'w'))\n"
        "print('ok')\n",
        encoding="utf-8",
    )
    run_id = _rid("env")
    target = _target([sys.executable, str(script)], env={"EXTRA": "hello"})

    await run_byo_cohort(
        run_id, target, _profile(), 1, runs_dir=tmp_path, proxy_base="http://testhost:9999"
    )

    env = json.loads((outdir / "env_0.json").read_text())
    assert env["OPENAI_BASE_URL"] == "http://testhost:9999/v1"
    assert env["SABOTEUR_RUN_ID"] == run_id
    assert env["SABOTEUR_AGENT_ID"] == "0"
    assert env["MODEL_ID"] == get_settings().model_id
    assert env["EXTRA"] == "hello"
    assert env["OPENAI_API_KEY"] is not None


# ---------------------------------------------------------------------------
# Per-agent terminal outcomes
# ---------------------------------------------------------------------------


async def test_clean_exit_is_completed(tmp_path):
    run_id = _rid("ok")
    await run_byo_cohort(run_id, _target(_PRINT_OK), _profile(), 2, runs_dir=tmp_path)
    run = manager.get(run_id)
    assert run is not None
    for i in (0, 1):
        done = _done(run, i)
        assert done.payload["outcome"] == "completed"
        assert done.payload["success"] is None
        assert done.payload["exit_code"] == 0


async def test_nonzero_exit_is_hard_exception(tmp_path):
    run_id = _rid("crash")
    await run_byo_cohort(run_id, _target(_CRASH), _profile(), 1, runs_dir=tmp_path)
    run = manager.get(run_id)
    done = _done(run, 0)
    assert done.payload["outcome"] == "hard_exception"
    assert done.payload["exit_code"] == 1


async def test_timeout_kill_is_bounded(tmp_path):
    run_id = _rid("timeout")
    sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
    # A 0.5s wall-clock cap must kill the 30s sleeper and finish the run fast.
    await run_byo_cohort(
        run_id, _target(sleeper), _profile(), 1, runs_dir=tmp_path, agent_timeout_s=0.5
    )
    run = manager.get(run_id)
    done = _done(run, 0)
    assert done.payload["outcome"] == "timeout"
    assert done.payload["timed_out"] is True


async def test_timeout_never_scores_as_success_even_with_lenient_oracle(tmp_path):
    # A SIGKILL'd agent must freeze success=False.
    #
    # The oracle is not consulted on a wall-clock kill — a lenient one (here a
    # match-anything regex) would otherwise pass the partial output of a process
    # that never completed the task.
    run_id = _rid("timeout-oracle")
    sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
    lenient = OracleConfig(kind="regex", pattern=".*")
    await run_byo_cohort(
        run_id,
        _target(sleeper, oracle=lenient),
        _profile(),
        1,
        runs_dir=tmp_path,
        agent_timeout_s=0.5,
    )
    run = manager.get(run_id)
    done = _done(run, 0)
    assert done.payload["outcome"] == "timeout"
    assert done.payload["success"] is False
    # The oracle is still recorded: this is a failed verdict, not "no oracle"
    # (survival_rate stays gated on, with the timeout counted as a failure).
    assert done.payload["oracle"] == "regex"
    assert "timeout" in done.payload["oracle_detail"]


# ---------------------------------------------------------------------------
# Crash isolation (one killed agent never affects its siblings)
# ---------------------------------------------------------------------------


async def test_crash_isolation_one_hang_others_complete(tmp_path):
    script = tmp_path / "branch.py"
    script.write_text(
        "import os, time\n"
        "if os.environ['SABOTEUR_AGENT_ID'] == '0':\n"
        "    time.sleep(30)\n"
        "print('ANSWER: 71.6')\n",
        encoding="utf-8",
    )
    run_id = _rid("iso")
    await run_byo_cohort(
        run_id,
        _target([sys.executable, str(script)]),
        _profile(),
        3,
        runs_dir=tmp_path,
        agent_timeout_s=0.5,
        concurrency_limit=8,
    )
    run = manager.get(run_id)
    assert _done(run, 0).payload["outcome"] == "timeout"
    assert _done(run, 1).payload["outcome"] == "completed"
    assert _done(run, 2).payload["outcome"] == "completed"


async def test_spawn_failure_is_isolated_hard_exception(tmp_path):
    run_id = _rid("badcmd")
    # A non-existent binary fails to spawn → that agent is hard_exception only.
    target = Target(name="byo", kind="command", cmd=["/no/such/binary/xyzzy"])
    await run_byo_cohort(run_id, target, _profile(), 2, runs_dir=tmp_path)
    run = manager.get(run_id)
    assert _done(run, 0).payload["outcome"] == "hard_exception"
    assert _done(run, 1).payload["outcome"] == "hard_exception"


# ---------------------------------------------------------------------------
# Oracle freeze → survival gating
# ---------------------------------------------------------------------------


async def test_regex_oracle_freezes_success_and_gates_survival(tmp_path):
    run_id = _rid("oracle")
    target = _target(_PRINT_OK, oracle=OracleConfig(kind="regex", pattern=r"71\.6"))
    await run_byo_cohort(run_id, target, _profile(), 2, runs_dir=tmp_path)
    run = manager.get(run_id)

    done = _done(run, 0)
    assert done.payload["success"] is True
    assert done.payload["oracle"] == "regex"
    assert done.payload["deception_aware"] is False

    card = Scorecard.model_validate_json(
        (tmp_path / f"{run_id}.scorecard.json").read_text()
    )
    assert card.survival_rate == 1.0
    assert card.deception_detection_rate is None
    assert card.deception_detection_rate_reason == "deception_requires_reference_oracle"


async def test_no_oracle_leaves_survival_null(tmp_path):
    run_id = _rid("noor")
    await run_byo_cohort(run_id, _target(_PRINT_OK), _profile(), 1, runs_dir=tmp_path)
    card = Scorecard.model_validate_json(
        (tmp_path / f"{run_id}.scorecard.json").read_text()
    )
    assert card.survival_rate is None
    assert card.survival_rate_reason == "no_oracle"


# ---------------------------------------------------------------------------
# Replay parity (invariant #3)
# ---------------------------------------------------------------------------


async def test_replay_parity_rescore_equals_persisted(tmp_path):
    run_id = _rid("replay")
    target = _target(_PRINT_OK, oracle=OracleConfig(kind="regex", pattern=r"71\.6"))
    await run_byo_cohort(run_id, target, _profile(), 3, runs_dir=tmp_path)

    persisted = Scorecard.model_validate_json(
        (tmp_path / f"{run_id}.scorecard.json").read_text()
    )
    rescored = score(
        read_jsonl(tmp_path / f"{run_id}.jsonl"),
        [],
        run_id=run_id,
        profile="probe",
    )
    assert rescored.model_dump() == persisted.model_dump()
    assert persisted.n_agents == 3
