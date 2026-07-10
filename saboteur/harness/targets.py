"""Target abstraction and registry.

Defines target kinds (reference vs. command) and manages target storage in the DB.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict

from saboteur.agents.oracle import (
    AssertionCommandOracle,
    HttpCallbackOracle,
    Oracle,
    RegexOracle,
)
from saboteur.storage.db import Database
from saboteur.storage.db import db as _default_db

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class OracleConfig(BaseModel):
    # how to judge a BYO command target's success (optional)

    model_config = ConfigDict(extra="forbid")

    kind: Literal["none", "regex", "command", "http"] = "none"
    pattern: str | None = None  # regex matched against final output
    command: str | None = None  # exit code 0 is success
    url: str | None = None  # http callback post trace returning success


class Target(BaseModel):
    # one runnable agent under test (the reference agent or a BYO command)

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: Literal["reference", "command"]
    cmd: list[str] | None = None  # argv for a command target
    cwd: str | None = None  # working dir for the subprocess
    env: dict[str, str] = {}  # extra env vars for the subprocess
    oracle: OracleConfig = OracleConfig()


# built-in default target
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
    # raised by TargetStore.add when the name is already taken
    pass


class TargetNotFoundError(KeyError):
    # raised by TargetStore.delete for an unknown / undeletable name
    pass


class TargetStore:
    # SQLite targets store manager

    def __init__(self, db: Database | None = None) -> None:
        self._db = db if db is not None else _default_db



    def _stored(self) -> list[Target]:
        targets: list[Target] = []
        for data in self._db.targets_all():
            try:
                targets.append(Target.model_validate(data))
            except ValueError:
                continue  # skip a corrupt entry rather than failing the whole list
        return targets

    def all(self) -> list[Target]:
        # all targets, reference first, then stored command targets
        return [REFERENCE_TARGET, *self._stored()]

    def get(self, name: str) -> Target | None:
        if name == REFERENCE_TARGET.name:
            return REFERENCE_TARGET
        data = self._db.target_get(name)
        if data is None:
            return None
        try:
            return Target.model_validate(data)
        except ValueError:
            return None



    def _validate(self, target: Target) -> None:
        # shared create/update validation (raises ValueError on a bad spec)
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
        build_oracle(target.oracle)  # raises ValueError on a bad oracle config

    def add(self, target: Target) -> Target:
        # register a command target; raises on reserved name or duplicate
        self._validate(target)
        if self._db.target_get(target.name) is not None:
            raise TargetExistsError(f"target {target.name!r} already exists")
        self._db.target_upsert(target.name, target.model_dump())
        return target

    def update(self, target: Target) -> Target:
        """Update an existing command target (raises if it does not exist)."""
        self._validate(target)
        if self._db.target_get(target.name) is None:
            raise TargetNotFoundError(target.name)
        self._db.target_upsert(target.name, target.model_dump())
        return target

    def delete(self, name: str) -> None:
        """Remove a stored command target. Reference is not deletable."""
        if name == REFERENCE_TARGET.name:
            raise TargetNotFoundError("'reference' is built-in and cannot be deleted")
        if not self._db.target_delete(name):
            raise TargetNotFoundError(name)



target_store = TargetStore()
