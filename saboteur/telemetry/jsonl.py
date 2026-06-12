"""JSONL writer — subscribes to a TelemetryBus and flushes every event to disk.

The file ``runs/{run_id}.jsonl`` is the replay fallback (invariant #3):
scoring and the dashboard must render identically from this file as from the
live event stream. Flush per event so a crash never leaves the log incomplete.

Usage::

    writer = JsonlWriter(bus, run_id, runs_dir=Path("runs"))
    asyncio.create_task(writer.run())   # runs until the bus closes
"""

from __future__ import annotations

from pathlib import Path

from .bus import TelemetryBus
from .schema import TelemetryEvent

_DEFAULT_RUNS_DIR = Path("runs")


class JsonlWriter:
    """Async subscriber that appends every event as one JSON line."""

    def __init__(
        self,
        bus: TelemetryBus,
        run_id: str,
        runs_dir: Path = _DEFAULT_RUNS_DIR,
    ) -> None:
        self._bus = bus
        self._run_id = run_id
        self._runs_dir = runs_dir

    @property
    def path(self) -> Path:
        return self._runs_dir / f"{self._run_id}.jsonl"

    async def run(self) -> None:
        """Subscribe to the bus and write until it closes.

        Creates the runs directory if necessary. Flushed after every event so
        the file is always a valid, complete record of events received so far.
        """
        self._runs_dir.mkdir(parents=True, exist_ok=True)
        async with self._bus.subscribe() as events:
            with self.path.open("a", encoding="utf-8") as fh:
                async for event in events:
                    fh.write(event.model_dump_json() + "\n")
                    fh.flush()


def read_jsonl(path: Path) -> list[TelemetryEvent]:
    """Read and parse every event in a JSONL log file.

    Returns events in file order. Raises on parse errors so callers know the
    log is corrupt (rather than silently dropping events).
    """
    events: list[TelemetryEvent] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                events.append(TelemetryEvent.model_validate_json(line))
    return events
