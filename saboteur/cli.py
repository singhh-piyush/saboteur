"""saboteur — CLI command interface and CI gate.

exit codes: 0 pass, 1 threshold breach, 2 usage error.
"""

from __future__ import annotations

import asyncio
import subprocess
import os
import socket
import sys
import time
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlsplit

import click
import httpx

from saboteur.config import get_settings

_PROFILES_DIR = Path("profiles")
_RUNS_DIR = Path("runs")

# metric gating buckets
_ORACLE_GATED = {"survival_rate", "deception_detection_rate"}
_CONTROL_GATED = {"waste_factor"}
_GATEABLE = _ORACLE_GATED | _CONTROL_GATED | {"mttr_steps", "crash_rate"}
# latency_degradation is not a hard CI gate to avoid noisy metrics blocking merges
_UNGATEABLE_METRICS = {
    "latency_degradation": (
        "latency_degradation is not a hard gate metric: it is contaminated by "
        "-np N batching contention (soft/secondary). Gate on survival_rate, "
        "crash_rate, mttr_steps, or waste_factor instead."
    ),
}


def _die(message: str, code: int = 2) -> NoReturn:
    # print error and exit
    click.echo(f"error: {message}", err=True)
    sys.exit(code)


def _fmt(value: float | None, suffix: str = "") -> str:
    return "—" if value is None else f"{value:.2f}{suffix}"


def _pct(value: float | None, reason: str | None = None) -> str:
    if value is None:
        return f"— ({reason})" if reason else "—"
    return f"{value:.0%}"


def _api_base(override: str | None) -> str:
    # explicit override or configured dashboard app URL
    return (override or get_settings().proxy_public_base_url).rstrip("/")


def _print_scorecard(sc: dict[str, Any], target: str) -> None:
    # print scorecard table
    rows = [
        ("run_id", sc.get("run_id", "—")),
        ("profile", sc.get("profile", "—")),
        ("target", target),
        ("agents", str(sc.get("n_agents", "—"))),
        ("oracle", sc.get("oracle") or "—"),
        ("survival_rate", _pct(sc.get("survival_rate"), sc.get("survival_rate_reason"))),
        ("mttr_steps", _fmt(sc.get("mttr_steps"))),
        ("crash_rate", _pct(sc.get("crash_rate"))),
        ("waste_factor", _fmt(sc.get("waste_factor"), "x")),
        ("latency_degradation", _fmt(sc.get("latency_degradation"), "x")),
        (
            "deception_rate",
            _pct(
                sc.get("deception_detection_rate"),
                sc.get("deception_detection_rate_reason"),
            ),
        ),
        ("recovery", _kv(sc.get("recovery_breakdown")) or "—"),
        ("failure_modes", _kv(sc.get("failure_modes")) or "—"),
    ]
    width = max(len(label) for label, _ in rows)
    click.echo("─" * 60)
    click.echo("Resilience Scorecard")
    click.echo("─" * 60)
    for label, value in rows:
        click.echo(f"  {label:<{width}}  {value}")
    click.echo("─" * 60)


def _kv(d: dict[str, int] | None) -> str:
    if not d:
        return ""
    return " ".join(f"{k}={v}" for k, v in d.items())


def _print_artifacts(run_id: str, *, control: bool) -> None:
    # list artifact paths with existence status
    names = [f"{run_id}.jsonl", f"{run_id}.scorecard.json"]
    if control:
        names = [f"{run_id}-control.jsonl", *names]
    click.echo("artifacts:")
    for name in names:
        path = _RUNS_DIR / name
        click.echo(f"  [{'ok' if path.exists() else 'MISSING'}] {path}")


def _server_up(base: str) -> bool:
    try:
        return httpx.get(f"{base}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False


def _ensure_server(base: str) -> tuple[str, subprocess.Popen | None]:
    # reuse running server or start new one; caller terminates started process
    if _server_up(base):
        return base, None
    parts = urlsplit(base)
    host, port = parts.hostname or "127.0.0.1", parts.port or 8000
    click.echo(f"no server at {base} — starting uvicorn on {host}:{port} …", err=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "saboteur.api:app",
         "--host", host, "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(60):  # up to ~30 s
        if _server_up(base):
            return base, proc
        if proc.poll() is not None:  # died on startup
            _stop_server(proc)
            _die(f"server failed to start on {host}:{port}")
        time.sleep(0.5)
    _stop_server(proc)
    _die(f"server did not become healthy at {base} within 30s")
    return base, None  # unreachable (_die exits)


def _stop_server(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _start_mock() -> subprocess.Popen:
    # start mock inference server, set OPENAI_BASE_URL, clear settings cache
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    base = f"http://127.0.0.1:{port}"
    click.echo(f"starting mock inference server on {base} …", err=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "saboteur.mock_inference:app",
         "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        if _server_up(base):
            break
        if proc.poll() is not None:
            _stop_server(proc)
            _die("mock inference server failed to start")
        time.sleep(0.5)
    else:
        _stop_server(proc)
        _die("mock inference server did not become healthy")
    os.environ["OPENAI_BASE_URL"] = f"{base}/v1"
    os.environ["OPENAI_API_KEY"] = "none"
    os.environ["MODEL_ID"] = "saboteur-mock"
    get_settings.cache_clear()
    return proc


def _run_reference(profile: str, n: int, control: bool) -> dict[str, Any]:
    # run reference cohort in-process and return scorecard
    from saboteur.harness import orchestrate

    scorecard = asyncio.run(
        orchestrate(_PROFILES_DIR / f"{profile}.yaml", n_agents=n, with_control=control)
    )
    return scorecard.model_dump()


def _run_byo_via_api(base: str, target: str, profile: str, n: int) -> dict[str, Any]:
    # run byo target via api, poll to completion, return scorecard
    with httpx.Client(base_url=base, timeout=30.0) as client:
        resp = client.post(
            "/runs",
            json={"target": target, "profile": profile, "n_agents": n,
                  "with_control": False},
        )
        if resp.status_code >= 400:
            _die(f"POST /runs failed ({resp.status_code}): {resp.text}")
        run_id = resp.json()["run_id"]
        click.echo(f"run_id: {run_id} — waiting for completion …", err=True)

        settings = get_settings()
        deadline = time.monotonic() + settings.agent_timeout_s * max(n, 1) + 120
        while time.monotonic() < deadline:
            status = client.get(f"/runs/{run_id}").json().get("status")
            if status == "finished":
                break
            if status == "failed":
                _die(f"run {run_id} failed")
            time.sleep(2.0)
        else:
            _die(f"run {run_id} did not finish in time")

        sc = client.get(f"/runs/{run_id}/scorecard")
        if sc.status_code >= 400:
            _die(f"scorecard unavailable ({sc.status_code}): {sc.text}")
        return sc.json()


# gate direction: true for floor (fail below), false for ceiling (fail above)
_HIGHER_IS_BETTER: dict[str, bool] = {
    "survival_rate": True,
    "deception_detection_rate": True,
    "mttr_steps": False,
    "waste_factor": False,
    "crash_rate": False,
}


def _evaluate_ci(
    sc: dict[str, Any], metric: str, threshold: float
) -> tuple[int, str]:
    # evaluate ci threshold; returns (exit_code, message)
    if metric in _UNGATEABLE_METRICS:
        return 2, _UNGATEABLE_METRICS[metric]
    if metric not in _GATEABLE:
        return 2, (
            f"unknown --metric {metric!r}; choose one of: "
            f"{', '.join(sorted(_GATEABLE))}"
        )
    value = sc.get(metric)
    if value is None:
        reason = sc.get(f"{metric}_reason")
        if reason is None and metric in _CONTROL_GATED:
            reason = "no control cohort — re-run with --control"
        hint = f" ({reason})" if reason else ""
        return 2, (
            f"metric {metric!r} is null{hint}; cannot gate. "
            "Pick a metric this run actually produces."
        )
    higher_is_better = _HIGHER_IS_BETTER.get(metric, True)
    failed = value < threshold if higher_is_better else value > threshold
    rel = ("<" if failed else "≥") if higher_is_better else (">" if failed else "≤")
    verdict = "FAIL" if failed else "PASS"
    return (1 if failed else 0), (
        f"CI gate: {metric} {value:.2f} {rel} {threshold:.2f} → {verdict}"
    )


def _preflight_ci(target, metric: str, control: bool) -> None:
    # check ci gating requirements before running cohort
    from saboteur.harness.targets import build_oracle

    if metric in _UNGATEABLE_METRICS:
        _die(_UNGATEABLE_METRICS[metric])
    if metric not in _GATEABLE:
        _die(
            f"unknown --metric {metric!r}; choose one of: "
            f"{', '.join(sorted(_GATEABLE))}"
        )
    if metric in _ORACLE_GATED:
        has_oracle = target.kind == "reference" or build_oracle(target.oracle) is not None
        if not has_oracle:
            _die(
                f"--metric {metric!r} needs a success oracle, but target "
                f"{target.name!r} has none. Attach an oracle to the target, or "
                "gate on a behavioral metric (mttr_steps, crash_rate)."
            )
        if metric == "deception_detection_rate" and target.kind != "reference":
            _die(
                "deception_detection_rate requires the reference ground-truth "
                "oracle; it is null for BYO targets."
            )
    if metric in _CONTROL_GATED and not control:
        _die(f"--metric {metric!r} needs a control cohort; re-run with --control.")


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(package_name="saboteur", message="%(version)s")
def main() -> None:
    """saboteur — chaos engineering."""


@main.command("run")
@click.option("--target", required=True, help="Target name ('reference' or a BYO target).")
@click.option("--profile", required=True, help="Chaos profile name (see `saboteur profiles`).")
@click.option("--n", "n_agents", type=int, default=None, help="Cohort size (default: settings.n_agents).")
@click.option("--control/--no-control", default=False, help="Also run a calm_seas control cohort (default off).")
@click.option("--ci", is_flag=True, help="Gate mode: exit non-zero when --metric breaches --threshold (direction-aware).")
@click.option("--threshold", type=float, default=0.7, show_default=True, help="CI threshold: a floor for higher-is-better metrics (survival_rate), a ceiling for lower-is-better ones (crash_rate, mttr_steps, waste_factor).")
@click.option("--metric", default="survival_rate", show_default=True, help="Metric to gate on in --ci mode.")
@click.option("--api", default=None, help="API base for BYO targets (default: settings.proxy_public_base_url).")
@click.option("--mock", is_flag=True, help="Use the bundled deterministic mock model (reference, offline — no GPU/secrets).")
def run_cmd(
    target: str,
    profile: str,
    n_agents: int | None,
    control: bool,
    ci: bool,
    threshold: float,
    metric: str,
    api: str | None,
    mock: bool,
) -> None:
    """Run a cohort under a chaos profile and print the scorecard.

    Reference targets run in-process (no server). BYO command targets go through
    the API (a server is started if one isn't already up). In --ci mode the gate
    is direction-aware: a higher-is-better metric (survival_rate) fails below
    THRESHOLD; a lower-is-better metric (crash_rate, mttr_steps, waste_factor)
    fails above it. Exit 0 pass, 1 breach, 2 if the metric can't be gated.
    """
    from saboteur.harness.targets import target_store

    resolved = target_store.get(target)
    if resolved is None:
        _die(f"unknown target {target!r}; see `saboteur targets`.")
    if not (_PROFILES_DIR / f"{profile}.yaml").exists():
        _die(f"unknown profile {profile!r}; see `saboteur profiles`.")
    if mock and resolved.kind != "reference":
        _die("--mock is only supported for the reference target.")
    if ci:
        _preflight_ci(resolved, metric, control)

    n = n_agents if n_agents is not None else get_settings().n_agents

    proc: subprocess.Popen | None = None
    mock_proc: subprocess.Popen | None = None
    try:
        if resolved.kind == "reference":
            if mock:
                mock_proc = _start_mock()
            click.echo(f"running reference cohort: profile={profile} n={n} "
                       f"control={control}{' mock' if mock else ''} …", err=True)
            sc = _run_reference(profile, n, control)
        else:
            base, proc = _ensure_server(_api_base(api))
            click.echo(f"running BYO cohort '{target}': profile={profile} n={n} "
                       "(chaos-only) …", err=True)
            sc = _run_byo_via_api(base, target, profile, n)
    finally:
        _stop_server(proc)
        _stop_server(mock_proc)

    _print_scorecard(sc, target)
    _print_artifacts(sc.get("run_id", ""), control=control and resolved.kind == "reference")

    if ci:
        code, msg = _evaluate_ci(sc, metric, threshold)
        click.echo(msg, err=code != 0)
        sys.exit(code)


@main.command("profiles")
def profiles_cmd() -> None:
    # list the bundled chaos profiles
    from saboteur.chaos.profile import load_profile

    paths = sorted(_PROFILES_DIR.glob("*.yaml"))
    if not paths:
        _die(f"no profiles found in {_PROFILES_DIR}/")
    for path in paths:
        p = load_profile(path)
        faults = ", ".join(f"{f.type}@{f.probability:g}" for f in p.faults) or "(none)"
        click.echo(f"{p.name:<18} seed={p.seed:<6} {faults}")


@main.command("targets")
def targets_cmd() -> None:
    # list registered targets
    from saboteur.harness.targets import target_store

    for t in target_store.all():
        if t.kind == "reference":
            click.echo(f"{t.name:<18} reference   (built-in smolagents agent)")
        else:
            cmd = " ".join(t.cmd or [])
            if len(cmd) > 48:
                cmd = cmd[:45] + "…"
            click.echo(f"{t.name:<18} command     oracle={t.oracle.kind:<8} {cmd}")


def _fetch_compare(base: str, a: str, b: str) -> dict:
    # get run comparison from api
    with httpx.Client(base_url=base, timeout=30.0) as client:
        resp = client.get("/runs/compare", params={"a": a, "b": b})
    if resp.status_code >= 400:
        _die(f"compare failed ({resp.status_code}): {resp.text}")
    return resp.json()


def _fmt_metric(v: float | None) -> str:
    return "—" if v is None else f"{v:.3f}"


def _arrow(m: dict) -> str:
    if m.get("regressed"):
        return "🔴 regressed"
    delta = m.get("delta")
    if not delta:
        return "·"
    better = (delta > 0) == m.get("higher_is_better", True)
    return "🟢 improved" if better else "🟡"


def _render_compare(data: dict, *, markdown: bool) -> str:
    metrics: dict = data.get("metrics", {})
    regressions = data.get("regressions") or []
    if markdown:
        rows = [
            "### 🛡️ Saboteur resilience delta",
            f"base `{data.get('a')}` → PR `{data.get('b')}`",
            "",
            "| metric | base | PR | Δ | |",
            "|---|---|---|---|---|",
        ]
        for name, m in metrics.items():
            rows.append(
                f"| `{name}` | {_fmt_metric(m.get('a'))} | {_fmt_metric(m.get('b'))} "
                f"| {_fmt_metric(m.get('delta'))} | {_arrow(m)} |"
            )
        rows.append("")
        rows.append(
            "**Regressions:** " + ", ".join(f"`{r}`" for r in regressions)
            if regressions
            else "**No resilience regressions** ✅"
        )
        return "\n".join(rows)

    lines = [f"compare  base={data.get('a')}  PR={data.get('b')}", "─" * 60]
    for name, m in metrics.items():
        flag = "REGRESSED" if m.get("regressed") else ""
        lines.append(
            f"  {name:<24} base={_fmt_metric(m.get('a'))} "
            f"PR={_fmt_metric(m.get('b'))} Δ={_fmt_metric(m.get('delta'))} {flag}"
        )
    lines.append("─" * 60)
    lines.append(f"regressions: {', '.join(regressions) if regressions else 'none'}")
    return "\n".join(lines)


@main.command("compare")
@click.argument("a")
@click.argument("b")
@click.option("--api", default=None, help="API base (default: settings.proxy_public_base_url).")
@click.option("--markdown", is_flag=True, help="Render a Markdown table (for PR comments).")
def compare_cmd(a: str, b: str, api: str | None, markdown: bool) -> None:
    """Compare two runs A and B: per-metric delta (B−A) + regressions.

    Uses the /runs/compare endpoint; auto-starts a server if one isn't up (its
    startup indexes runs/, so both runs must have their JSONL+scorecard there).
    Prints a table to stdout — with --markdown, suitable for a PR comment body.
    """
    base, proc = _ensure_server(_api_base(api))
    try:
        data = _fetch_compare(base, a, b)
    finally:
        _stop_server(proc)
    click.echo(_render_compare(data, markdown=markdown))


@main.command("replay")
@click.argument("jsonl", type=click.Path())
@click.option("--speed", type=float, default=2.0, show_default=True, help="Replay speed (1.0 = real-time, 0 = instant).")
@click.option("--api", default=None, help="API base (default: settings.proxy_public_base_url).")
@click.option("--follow", is_flag=True, help="Stream replayed events to stdout as JSON.")
def replay_cmd(jsonl: str, speed: float, api: str | None, follow: bool) -> None:
    """Drive the live dashboard from a recorded JSONL log.

    Requires a running server (the dashboard's app) — replay injects into it.
    """
    base = _api_base(api)
    if not _server_up(base):
        _die(
            f"no Saboteur server at {base}. Start one first, e.g.:\n"
            "  bash scripts/run_local.sh        # llama-server + uvicorn\n"
            "  uvicorn saboteur.api:app         # API only"
        )
    with httpx.Client(base_url=base, timeout=10.0) as client:
        resp = client.post("/replay", json={"jsonl_path": jsonl, "speed": speed})
        if resp.status_code >= 400:
            _die(f"POST /replay failed ({resp.status_code}): {resp.text}")
        run_id = resp.json()["run_id"]
    click.echo(f"replaying as run_id: {run_id}")
    click.echo(f"watch it on the dashboard (run {run_id}) at {base}")

    if follow:
        _follow_ws(base, run_id)


def _follow_ws(base: str, run_id: str) -> None:
    # stream websocket channel to stdout
    import json

    try:
        import websockets  # websockets dependency
    except ImportError:
        _die("--follow needs the 'websockets' package")

    ws_url = base.replace("http://", "ws://").replace("https://", "wss://")

    async def _stream() -> None:
        async with websockets.connect(f"{ws_url}/ws/{run_id}") as ws:
            async for message in ws:
                click.echo(json.dumps(json.loads(message)))

    try:
        asyncio.run(_stream())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
