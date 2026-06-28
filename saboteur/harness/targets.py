"""Target abstraction + registry — *what* a cohort runs.

A **Target** is one runnable agent under test:

- ``reference`` — Saboteur's own smolagents ``ToolCallingAgent`` (the
  batteries-included default; faults injected at the tool-call boundary).
- ``command`` — a BYO agent we don't own, launched as a subprocess whose
  ``OPENAI_BASE_URL`` points at the wire proxy (faults injected on the wire).

Targets are persisted in a JSON-file store (``runs/targets.json``). The
reference target is built-in: always present, never stored, never deletable.
SQLite is a later WP; the JSON store keeps the v1 surface tiny.

A command target may carry an optional :class:`OracleConfig` describing how to
judge success (reusing the pluggable :mod:`saboteur.agents.oracle` classes —
never an LLM judge, invariant #4). ``build_oracle`` maps the config to an
:class:`~saboteur.agents.oracle.Oracle` (or ``None`` for behavioral-only runs).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from saboteur.agents.oracle import (
    AssertionCommandOracle,
    HttpCallbackOracle,
    Oracle,
    RegexOracle,
)

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_DEFAULT_STORE_PATH = Path("runs/targets.json")


class OracleConfig(BaseModel):
    """How to judge a BYO command target's success (optional).

    ``kind == "none"`` → behavioral tier only (survival stays ``null`` +
    ``no_oracle``). The other kinds map to the existing oracle classes.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["none", "regex", "command", "http"] = "none"
    pattern: str | None = None  # regex: matched against the agent's final output
    command: str | None = None  # assertion command: exit 0 == success
    url: str | None = None  # http callback: POST trace → {"success": bool}


class Target(BaseModel):
    """One runnable agent under test (the reference agent or a BYO command)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: Literal["reference", "command"]
    cmd: list[str] | None = None  # argv for a command target
    cwd: str | None = None  # working dir for the subprocess
    env: dict[str, str] = {}  # extra env vars for the subprocess
    oracle: OracleConfig = OracleConfig()


# The built-in default: Saboteur's own smolagents agent. Never stored on disk.
REFERENCE_TARGET = Target(name="reference", kind="reference")


def build_oracle(cfg: OracleConfig) -> Oracle | None:
    """Map an :class:`OracleConfig` to an :class:`Oracle` (or ``None``).

    ``None`` means "no success oracle" → behavioral-tier scoring only. Raises
    ``ValueError`` if a kind is selected without its required field.
    """
    if cfg.kind == "none":
        return None
    if cfg.kind == "regex":
        if not cfg.pattern:
            raise ValueError("oracle kind 'regex' requires 'pattern'")
        return RegexOracle(cfg.pattern)
    if cfg.kind == "command":
        if not cfg.command:
            raise ValueError("oracle kind 'command' requires 'command'")
        return AssertionCommandOracle(cfg.command)
    if cfg.kind == "http":
        if not cfg.url:
            raise ValueError("oracle kind 'http' requires 'url'")
        return HttpCallbackOracle(cfg.url)
    raise ValueError(f"unknown oracle kind: {cfg.kind!r}")  # pragma: no cover


class TargetExistsError(ValueError):
    """Raised by :meth:`TargetStore.add` when the name is already taken."""


class TargetNotFoundError(KeyError):
    """Raised by :meth:`TargetStore.delete` for an unknown / undeletable name."""


class TargetStore:
    """A JSON-file registry of command targets (reference is implicit).

    Every op does load → mutate → atomic write, so concurrent single-user
    access stays consistent without a long-lived handle. A missing or corrupt
    file reads as empty (the reference target is still available).
    """

    def __init__(self, path: Path = _DEFAULT_STORE_PATH) -> None:
        self.path = path

    # -- reads ----------------------------------------------------------

    def _load(self) -> list[Target]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = raw.get("targets", []) if isinstance(raw, dict) else []
        targets: list[Target] = []
        for item in items:
            try:
                targets.append(Target.model_validate(item))
            except ValueError:
                continue  # skip a corrupt entry rather than failing the whole list
        return targets

    def all(self) -> list[Target]:
        """All targets, reference first, then stored command targets."""
        return [REFERENCE_TARGET, *self._load()]

    def get(self, name: str) -> Target | None:
        if name == REFERENCE_TARGET.name:
            return REFERENCE_TARGET
        return next((t for t in self._load() if t.name == name), None)

    # -- writes ---------------------------------------------------------

    def _save(self, targets: list[Target]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"targets": [t.model_dump() for t in targets]}
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)  # atomic on POSIX

    def add(self, target: Target) -> Target:
        """Register a command target. Raises on a reserved name or duplicate."""
        if target.name == REFERENCE_TARGET.name:
            raise TargetExistsError("'reference' is a reserved built-in target")
        if not _NAME_RE.match(target.name):
            raise ValueError(
                f"target name {target.name!r} must match [A-Za-z0-9_-]+"
            )
        if target.kind != "command":
            raise ValueError("only 'command' targets can be registered")
        if not target.cmd:
            raise ValueError("a command target requires a non-empty 'cmd'")
        existing = self._load()
        if any(t.name == target.name for t in existing):
            raise TargetExistsError(f"target {target.name!r} already exists")
        existing.append(target)
        self._save(existing)
        return target

    def delete(self, name: str) -> None:
        """Remove a stored command target. Reference is not deletable."""
        if name == REFERENCE_TARGET.name:
            raise TargetNotFoundError("'reference' is built-in and cannot be deleted")
        existing = self._load()
        kept = [t for t in existing if t.name != name]
        if len(kept) == len(existing):
            raise TargetNotFoundError(name)
        self._save(kept)


# Module singleton; tests construct their own TargetStore on a tmp path.
target_store = TargetStore()
