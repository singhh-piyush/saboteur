"""writes telemetry bus events to a jsonl file on disk"""

from __future__ import annotations

from pathlib import Path

from .bus import TelemetryBus
from .schema import TelemetryEvent

_DEFAULT_RUNS_DIR = Path("runs")


class JsonlWriter:
    # write telemetry events to disk

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
        # subscribe to bus and write flushed json lines
        self._runs_dir.mkdir(parents=True, exist_ok=True)
        async with self._bus.subscribe() as events:
            with self.path.open("a", encoding="utf-8") as fh:
                async for event in events:
                    fh.write(event.model_dump_json() + "\n")
                    fh.flush()


def read_jsonl(path: Path) -> list[TelemetryEvent]:
    # read and parse all events from a jsonl file
    events: list[TelemetryEvent] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                events.append(TelemetryEvent.model_validate_json(line))
    return events
