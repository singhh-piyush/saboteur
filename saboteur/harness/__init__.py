"""Harness: concurrent battle royale, scoring, and run orchestration.

Public API::

    from saboteur.harness import (
        battle_royale, RunReport, AgentFactory,
        score, Scorecard,
        orchestrate,
        to_telemetry, make_on_event,
    )
"""

from .battle import AgentFactory, RunReport, battle_royale
from .instrumentation import make_on_event, to_telemetry
from .runner import make_run_id, orchestrate
from .scoring import Scorecard, score

__all__ = [
    "AgentFactory",
    "RunReport",
    "Scorecard",
    "battle_royale",
    "make_on_event",
    "make_run_id",
    "orchestrate",
    "score",
    "to_telemetry",
]
