"""Harness: concurrent cohort runs, scoring, and run orchestration.

Public API::

    from saboteur.harness import (
        cohort_run, RunReport, AgentFactory,
        score, Scorecard,
        orchestrate,
        to_telemetry, make_on_event,
    )
"""

from .cohort import AgentFactory, RunReport, cohort_run
from .instrumentation import make_on_event, to_telemetry
from .runner import make_run_id, orchestrate
from .scoring import Scorecard, score

__all__ = [
    "AgentFactory",
    "RunReport",
    "Scorecard",
    "cohort_run",
    "make_on_event",
    "make_run_id",
    "orchestrate",
    "score",
    "to_telemetry",
]
