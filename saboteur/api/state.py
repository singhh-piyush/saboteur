from __future__ import annotations

from dataclasses import dataclass
import asyncio
from datetime import datetime
from enum import Enum


class RunStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    FINISHED = "finished"
    FAILED = "failed"


@dataclass
class RunState:
    run_id: str
    profile: str
    n_agents: int
    with_control: bool
    status: RunStatus = RunStatus.PENDING
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    task: asyncio.Task | None = None


class RunRegistry:
    def __init__(self) -> None:
        self._runs: dict[str, RunState] = {}

    def add(self, state: RunState) -> None:
        self._runs[state.run_id] = state

    def get(self, run_id: str) -> RunState | None:
        return self._runs.get(run_id)

    def all(self) -> list[RunState]:
        return list(self._runs.values())


run_registry = RunRegistry()
