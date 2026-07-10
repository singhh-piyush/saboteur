"""CLI tests — server-free via click's CliRunner.

The ``run`` command's executors (``_run_reference`` / ``_run_byo_via_api``) and
the server probe (``_server_up``) are module-level seams: tests monkeypatch them
to return canned scorecards, so the exit-code contract is exercised without a
running server.
"""

from __future__ import annotations

import pytest
from click.testing import CliRunner

from saboteur import cli
from saboteur.harness.targets import Target, TargetStore
from saboteur.storage.db import Database


def _sc(**over) -> dict:
    base = {
        "run_id": "hell_mode-20260629T000000-abcdef",
        "profile": "hell_mode",
        "n_agents": 8,
        "mttr_steps": 3.0,
        "recovery_breakdown": {"retry": 4, "reformulate": 2},
        "waste_factor": None,
        "failure_modes": {"hard_exception": 2, "timeout": 1},
        "crash_rate": 0.25,
        "latency_degradation": None,
        "survival_rate": 0.13,
        "survival_rate_reason": None,
        "deception_detection_rate": None,
        "deception_detection_rate_reason": "no_deception_probe",
        "oracle": "builtin_reference",
        "control_run_id": None,
        "per_agent": {},
    }
    base.update(over)
    return base


@pytest.fixture()
def runner() -> CliRunner:
    return CliRunner()


def _byo_store(tmp_path, *, oracle_kind="none") -> TargetStore:
    from saboteur.harness.targets import OracleConfig

    store = TargetStore(Database(tmp_path / "saboteur.db"))
    oracle = (
        OracleConfig(kind="regex", pattern="ANSWER")
        if oracle_kind == "regex"
        else OracleConfig(kind="none")
    )
    store.add(Target(name="byo", kind="command", cmd=["python", "-c", "pass"], oracle=oracle))
    return store


# ---------------------------------------------------------------------------
# run — CI exit-code contract (the acceptance beat)
# ---------------------------------------------------------------------------


def test_run_reference_ci_below_threshold_exits_1(runner, monkeypatch):
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc(survival_rate=0.13))
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--ci", "--threshold", "0.9"],
    )
    assert res.exit_code == 1
    assert "FAIL" in res.output


def test_run_reference_ci_above_threshold_exits_0(runner, monkeypatch):
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc(profile="calm_seas", survival_rate=1.0))
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "calm_seas", "--ci", "--threshold", "0.9"],
    )
    assert res.exit_code == 0
    assert "PASS" in res.output


def test_run_without_ci_exits_0_and_prints_table(runner, monkeypatch):
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc())
    res = runner.invoke(cli.main, ["run", "--target", "reference", "--profile", "hell_mode"])
    assert res.exit_code == 0
    assert "Resilience Scorecard" in res.output
    assert "survival_rate" in res.output


# ---------------------------------------------------------------------------
# run — loud failures (exit 2) before spending a cohort
# ---------------------------------------------------------------------------


def test_oracle_metric_on_no_oracle_target_exits_2(runner, monkeypatch, tmp_path):
    monkeypatch.setattr("saboteur.harness.targets.target_store", _byo_store(tmp_path))
    called = []
    monkeypatch.setattr(cli, "_run_byo_via_api", lambda *a, **k: called.append(1) or _sc())
    res = runner.invoke(
        cli.main,
        ["run", "--target", "byo", "--profile", "flaky_friday", "--ci"],  # default metric survival_rate
    )
    assert res.exit_code == 2
    assert "oracle" in res.output.lower()
    assert called == []


def test_waste_factor_without_control_exits_2(runner, monkeypatch):
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc())
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--ci", "--metric", "waste_factor"],
    )
    assert res.exit_code == 2
    assert "control" in res.output.lower()


def test_unknown_metric_exits_2(runner):
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--ci", "--metric", "bogus"],
    )
    assert res.exit_code == 2
    assert "bogus" in res.output


def test_crash_rate_gate_is_a_ceiling_not_a_floor(runner, monkeypatch):
    # crash_rate is lower-is-better: a LOW value must PASS a threshold gate
    # (a ceiling), not fail it. Regression for the floor-only inversion bug.
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc(crash_rate=0.0))
    ok = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--ci",
         "--metric", "crash_rate", "--threshold", "0.5"],
    )
    assert ok.exit_code == 0, ok.output

    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc(crash_rate=0.8))
    bad = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--ci",
         "--metric", "crash_rate", "--threshold", "0.5"],
    )
    assert bad.exit_code == 1, bad.output


def test_latency_degradation_is_rejected_as_a_gate_metric(runner, monkeypatch):
    # latency_degradation is contention-contaminated — gating on it is a loud config error, even with --control.
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: pytest.fail("cohort ran"))
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--profile", "hell_mode", "--control",
         "--ci", "--metric", "latency_degradation"],
    )
    assert res.exit_code == 2
    assert "latency_degradation" in res.output
    assert "contention" in res.output.lower()


def test_unknown_target_exits_2(runner, monkeypatch, tmp_path):
    monkeypatch.setattr("saboteur.harness.targets.target_store", _byo_store(tmp_path))
    res = runner.invoke(cli.main, ["run", "--target", "nope", "--profile", "hell_mode"])
    assert res.exit_code == 2
    assert "unknown target" in res.output.lower()


def test_unknown_profile_exits_2(runner):
    res = runner.invoke(cli.main, ["run", "--target", "reference", "--profile", "no_such"])
    assert res.exit_code == 2
    assert "profile" in res.output.lower()


# ---------------------------------------------------------------------------
# run — BYO path goes through the API executor + gates on the result
# ---------------------------------------------------------------------------


def test_byo_with_oracle_runs_via_api_and_gates(runner, monkeypatch, tmp_path):
    monkeypatch.setattr("saboteur.harness.targets.target_store", _byo_store(tmp_path, oracle_kind="regex"))
    monkeypatch.setattr(cli, "_ensure_server", lambda base: (base, None))
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: pytest.fail("reference path used for BYO"))
    monkeypatch.setattr(cli, "_run_byo_via_api", lambda *a, **k: _sc(profile="flaky_friday", survival_rate=0.2, oracle="regex"))
    res = runner.invoke(
        cli.main,
        ["run", "--target", "byo", "--profile", "flaky_friday", "--ci", "--threshold", "0.9"],
    )
    assert res.exit_code == 1
    assert "FAIL" in res.output


# ---------------------------------------------------------------------------
# profiles / targets / replay
# ---------------------------------------------------------------------------


def test_profiles_lists_bundled(runner):
    res = runner.invoke(cli.main, ["profiles"])
    assert res.exit_code == 0
    assert "calm_seas" in res.output and "hell_mode" in res.output


def test_targets_lists_reference(runner, monkeypatch, tmp_path):
    monkeypatch.setattr("saboteur.harness.targets.target_store", _byo_store(tmp_path))
    res = runner.invoke(cli.main, ["targets"])
    assert res.exit_code == 0
    assert "reference" in res.output and "byo" in res.output


def test_replay_server_down_exits_2(runner, monkeypatch):
    monkeypatch.setattr(cli, "_server_up", lambda base: False)
    res = runner.invoke(cli.main, ["replay", "runs/whatever.jsonl"])
    assert res.exit_code == 2
    assert "no Saboteur server" in res.output


# ---------------------------------------------------------------------------
# compare
# ---------------------------------------------------------------------------


_COMPARE = {
    "a": "base-run",
    "b": "pr-run",
    "metrics": {
        "survival_rate": {"a": 0.95, "b": 0.60, "delta": -0.35, "regressed": True,
                          "higher_is_better": True, "threshold": 0.05},
        "crash_rate": {"a": 0.0, "b": 0.0, "delta": 0.0, "regressed": False,
                       "higher_is_better": False, "threshold": 0.05},
        "mttr_steps": {"a": None, "b": None, "delta": None, "regressed": False,
                       "higher_is_better": False, "threshold": 0.5},
    },
    "regressions": ["survival_rate"],
}


def test_render_compare_markdown_pure():
    out = cli._render_compare(_COMPARE, markdown=True)
    assert "| metric | base | PR | Δ |" in out
    assert "`survival_rate`" in out and "🔴 regressed" in out
    assert "**Regressions:** `survival_rate`" in out


def test_render_compare_plain_no_regression():
    data = {**_COMPARE, "regressions": []}
    out = cli._render_compare(data, markdown=False)
    assert "regressions: none" in out


def test_compare_cmd_markdown(runner, monkeypatch):
    monkeypatch.setattr(cli, "_ensure_server", lambda base: (base, None))
    monkeypatch.setattr(cli, "_fetch_compare", lambda base, a, b: _COMPARE)
    res = runner.invoke(cli.main, ["compare", "base-run", "pr-run", "--markdown"])
    assert res.exit_code == 0
    assert "Saboteur resilience delta" in res.output
    assert "survival_rate" in res.output


# ---------------------------------------------------------------------------
# run --mock
# ---------------------------------------------------------------------------


class _FakeProc:
    def terminate(self):
        pass

    def wait(self, timeout=None):
        return 0


def test_mock_flag_uses_mock_and_reference(runner, monkeypatch):
    started = []
    monkeypatch.setattr(cli, "_start_mock", lambda: started.append(1) or _FakeProc())
    monkeypatch.setattr(cli, "_run_reference", lambda *a, **k: _sc(profile="calm_seas", survival_rate=1.0))
    res = runner.invoke(
        cli.main,
        ["run", "--target", "reference", "--mock", "--profile", "calm_seas", "--ci", "--threshold", "0.5"],
    )
    assert res.exit_code == 0
    assert started == [1]


def test_mock_flag_rejected_for_byo(runner, monkeypatch, tmp_path):
    monkeypatch.setattr("saboteur.harness.targets.target_store", _byo_store(tmp_path))
    res = runner.invoke(
        cli.main, ["run", "--target", "byo", "--mock", "--profile", "calm_seas"]
    )
    assert res.exit_code == 2
    assert "--mock is only supported for the reference target" in res.output
