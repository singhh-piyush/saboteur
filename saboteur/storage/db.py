"""sqlite index over run logs.

the jsonl logs are the source of truth; the db is reconstructed on startup.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

_DEFAULT_DB_PATH = Path("runs/saboteur.db")


@dataclass
class RunRow:
    # runs index row derived from disk

    run_id: str
    target: str | None
    profile: str | None
    n_agents: int
    status: str  # disk-derived: "finished" (has scorecard) | "archived"
    started_at: str | None  # ISO-8601 (UTC)
    finished_at: str | None  # ISO-8601 (UTC), None if the run never finished
    has_scorecard: bool
    survival_rate: float | None
    summary: str | None  # full scorecard JSON text (the compare/detail source)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS targets (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    name        TEXT PRIMARY KEY,
    seed        INTEGER,
    description TEXT,
    faults      TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    target        TEXT,
    profile       TEXT,
    n_agents      INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT,
    has_scorecard INTEGER NOT NULL DEFAULT 0,
    survival_rate REAL,
    summary       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile);
CREATE INDEX IF NOT EXISTS idx_runs_target  ON runs(target);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
"""


class Database:
    # sqlite wrapper with per-operation connections and write lock

    def __init__(self, path: Path | str = _DEFAULT_DB_PATH) -> None:
        self.path = Path(path)
        self._write_lock = threading.Lock()
        self._ensure_lock = threading.Lock()
        self._ensured: set[str] = set()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        # open fresh sqlite connection for one operation
        self._ensure_schema()
        conn = sqlite3.connect(self.path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
        finally:
            conn.close()

    def _create_schema(self) -> None:
        # run idempotent ddl to ensure schema exists
        with self._ensure_lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=30.0)
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(_SCHEMA)
                conn.commit()
            finally:
                conn.close()
            self._ensured.add(str(self.path))

    def _ensure_schema(self) -> None:
        # ensure schema exists on first connection to path
        if str(self.path) in self._ensured:
            return
        self._create_schema()

    def init(self) -> None:
        # initialize schema on startup
        self._create_schema()



    def targets_all(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT data FROM targets ORDER BY name").fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                out.append(json.loads(r["data"]))
            except ValueError:
                continue  # skip a corrupt entry rather than failing the whole list
        return out

    def target_get(self, name: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT data FROM targets WHERE name=?", (name,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["data"])
        except ValueError:
            return None

    def target_upsert(self, name: str, data: dict[str, Any]) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO targets(name, data) VALUES(?, ?)",
                (name, json.dumps(data)),
            )
            conn.commit()

    def target_delete(self, name: str) -> bool:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM targets WHERE name=?", (name,))
            conn.commit()
            return cur.rowcount > 0



    def run_upsert(self, row: RunRow) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute(
                """INSERT INTO runs(run_id, target, profile, n_agents, status,
                        started_at, finished_at, has_scorecard, survival_rate, summary)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(run_id) DO UPDATE SET
                        target=excluded.target,
                        profile=excluded.profile,
                        n_agents=excluded.n_agents,
                        status=excluded.status,
                        started_at=excluded.started_at,
                        finished_at=excluded.finished_at,
                        has_scorecard=excluded.has_scorecard,
                        survival_rate=excluded.survival_rate,
                        summary=excluded.summary""",
                (
                    row.run_id,
                    row.target,
                    row.profile,
                    row.n_agents,
                    row.status,
                    row.started_at,
                    row.finished_at,
                    int(row.has_scorecard),
                    row.survival_rate,
                    row.summary,
                ),
            )
            conn.commit()

    def run_get(self, run_id: str) -> RunRow | None:
        with self._conn() as conn:
            r = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return _row_to_runrow(r) if r is not None else None

    def runs_all(self) -> list[RunRow]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM runs").fetchall()
        return [_row_to_runrow(r) for r in rows]

    def run_ids(self) -> set[str]:
        with self._conn() as conn:
            rows = conn.execute("SELECT run_id FROM runs").fetchall()
        return {r["run_id"] for r in rows}

    def run_delete(self, run_id: str) -> bool:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
            conn.commit()
            return cur.rowcount > 0



    def profile_upsert(
        self, name: str, seed: int | None, description: str | None, faults: list[str]
    ) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute(
                """INSERT INTO profiles(name, seed, description, faults)
                   VALUES(?, ?, ?, ?)
                   ON CONFLICT(name) DO UPDATE SET
                        seed=excluded.seed,
                        description=excluded.description,
                        faults=excluded.faults""",
                (name, seed, description, json.dumps(faults)),
            )
            conn.commit()

    def profiles_all(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM profiles ORDER BY name").fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                faults = json.loads(r["faults"]) if r["faults"] else []
            except ValueError:
                faults = []
            out.append(
                {
                    "name": r["name"],
                    "seed": r["seed"],
                    "description": r["description"],
                    "faults": faults,
                }
            )
        return out





def _row_to_runrow(r: sqlite3.Row) -> RunRow:
    return RunRow(
        run_id=r["run_id"],
        target=r["target"],
        profile=r["profile"],
        n_agents=r["n_agents"],
        status=r["status"],
        started_at=r["started_at"],
        finished_at=r["finished_at"],
        has_scorecard=bool(r["has_scorecard"]),
        survival_rate=r["survival_rate"],
        summary=r["summary"],
    )





def _split_run_id(run_id: str) -> tuple[str, str | None]:
    # split run_id into prefix and timestamp
    parts = run_id.rsplit("-", 2)
    if len(parts) == 3:
        return parts[0], parts[1]
    return run_id, None


def _stamp_to_iso(run_id: str) -> str | None:
    # recover started_at from run_id timestamp
    _, stamp = _split_run_id(run_id)
    if stamp is None:
        return None
    try:
        dt = datetime.strptime(stamp, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.isoformat()


def derive_target(run_id: str, profile: str | None) -> str:
    # derive target from run_id prefix
    prefix, _ = _split_run_id(run_id)
    if profile and prefix == profile:
        return "reference"
    return prefix or "reference"


def _extract_run_meta(path: Path) -> dict[str, Any]:
    # scan jsonl file for run metadata
    meta: dict[str, Any] = {
        "profile": None,
        "n_agents": None,
        "seed": None,
        "started_at": None,
        "finished_at": None,
    }
    first_ts: str | None = None
    run_started_ts: str | None = None
    run_finished_ts: str | None = None
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                ts = ev.get("ts")
                if first_ts is None and ts:
                    first_ts = ts
                kind = ev.get("event")
                if kind == "run_started":
                    run_started_ts = ts or run_started_ts
                    p = ev.get("payload") or {}
                    meta["profile"] = p.get("profile", meta["profile"])
                    meta["n_agents"] = p.get("n_agents", meta["n_agents"])
                    meta["seed"] = p.get("seed", meta["seed"])
                elif kind == "run_finished":
                    run_finished_ts = ts or run_finished_ts
    except OSError:
        return meta
    meta["started_at"] = run_started_ts or first_ts
    meta["finished_at"] = run_finished_ts
    return meta


def build_run_row(runs_dir: Path, run_id: str) -> RunRow | None:
    # build run row from log and scorecard files
    jsonl = runs_dir / f"{run_id}.jsonl"
    scorecard = runs_dir / f"{run_id}.scorecard.json"
    if not jsonl.exists() and not scorecard.exists():
        return None

    meta = (
        _extract_run_meta(jsonl)
        if jsonl.exists()
        else {"profile": None, "n_agents": None, "started_at": None, "finished_at": None}
    )
    profile = meta.get("profile")
    n_agents = meta.get("n_agents") or 0
    survival: float | None = None
    summary: str | None = None
    has_sc = scorecard.exists()

    if has_sc:
        try:
            text = scorecard.read_text(encoding="utf-8")
            sc = json.loads(text)
            profile = sc.get("profile") or profile
            n_agents = sc.get("n_agents") or n_agents or 0
            survival = sc.get("survival_rate")
            summary = text
        except (OSError, ValueError):
            has_sc = False

    started = meta.get("started_at") or _stamp_to_iso(run_id)
    finished = meta.get("finished_at")
    status = "finished" if has_sc else "archived"
    return RunRow(
        run_id=run_id,
        target=derive_target(run_id, profile),
        profile=profile,
        n_agents=int(n_agents or 0),
        status=status,
        started_at=started,
        finished_at=finished,
        has_scorecard=has_sc,
        survival_rate=survival,
        summary=summary,
    )


def reconcile_runs(db: Database, runs_dir: Path) -> None:
    # sync runs table with files on disk
    if not runs_dir.is_dir():
        return
    on_disk: set[str] = set()
    for log in runs_dir.glob("*.jsonl"):
        run_id = log.stem
        if run_id.endswith("-control") or run_id.startswith("replay-"):
            continue
        on_disk.add(run_id)
        existing = db.run_get(run_id)
        sc_exists = (runs_dir / f"{run_id}.scorecard.json").exists()
        if existing is not None and existing.has_scorecard == sc_exists:
            continue  # already indexed and the scorecard state is unchanged
        row = build_run_row(runs_dir, run_id)
        if row is not None:
            db.run_upsert(row)
    for stale in db.run_ids() - on_disk:
        db.run_delete(stale)


def sync_profiles(db: Database, profiles_dir: Path) -> None:
    # sync profiles table with yaml files
    if not profiles_dir.is_dir():
        return
    import yaml

    for yml in profiles_dir.glob("*.yaml"):
        try:
            data = yaml.safe_load(yml.read_text(encoding="utf-8")) or {}
        except Exception:
            continue
        faults = data.get("faults") or []
        fault_types: list[str] = [
            f["type"]
            for f in faults
            if isinstance(f, dict) and isinstance(f.get("type"), str)
        ]
        try:
            db.profile_upsert(
                data.get("name") or yml.stem,
                data.get("seed"),
                data.get("description"),
                fault_types,
            )
        except Exception:
            continue


def backfill(db: Database, runs_dir: Path, profiles_dir: Path) -> None:
    # reindex runs and profiles from disk
    db.init()
    reconcile_runs(db, runs_dir)
    sync_profiles(db, profiles_dir)


# module singleton
db = Database()
