"""Programmatic task verifier.

Success is defined as filing a report with a value close to expected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from .task import GROUND_TRUTH
from .tools import ReportStore

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


class FailureReason(str, Enum):
    # verifier rejection reasons

    NO_REPORT = "no_report"
    WRONG_VALUE = "wrong_value"
    MALFORMED_REPORT = "malformed_report"


@dataclass(frozen=True)
class TaskResult:
    # verifier result for one run

    success: bool
    failure_reason: FailureReason | None
    found_value: float | None
    detail: str


def verify(
    report_store: ReportStore,
    agent_id: int,
    *,
    expected: float | None = None,
    tol: float = 0.5,
) -> TaskResult:
    """Check whether *agent_id* successfully completed the task.

    Args:
        report_store: The shared report store (keyed by agent_id).
        agent_id: Which agent to evaluate.
        expected: Target Fahrenheit value; defaults to
                  ``GROUND_TRUTH["tokyo_f"]`` (71.6).
        tol: Acceptable absolute deviation from *expected*.

    Returns:
        A :class:`TaskResult` describing success or the failure mode.
    """
    if expected is None:
        expected = GROUND_TRUTH["tokyo_f"]

    reports = report_store.get(agent_id)
    if not reports:
        return TaskResult(
            success=False,
            failure_reason=FailureReason.NO_REPORT,
            found_value=None,
            detail=f"Agent {agent_id} filed no reports.",
        )

    # scan reports for numbers
    candidates: list[float] = []
    for report in reports:
        text = report.title + " " + report.body
        candidates.extend(float(m.group()) for m in _NUMBER_RE.finditer(text))

    if not candidates:
        return TaskResult(
            success=False,
            failure_reason=FailureReason.MALFORMED_REPORT,
            found_value=None,
            detail=(
                f"Agent {agent_id} filed {len(reports)} report(s) but none "
                "contained a parseable numeric value."
            ),
        )

    # find candidate closest to expected value
    best = min(candidates, key=lambda v: abs(v - expected))
    error = abs(best - expected)

    if error <= tol:
        return TaskResult(
            success=True,
            failure_reason=None,
            found_value=best,
            detail=(
                f"Agent {agent_id} reported {best}°F "
                f"(expected {expected}°F ± {tol})."
            ),
        )

    return TaskResult(
        success=False,
        failure_reason=FailureReason.WRONG_VALUE,
        found_value=best,
        detail=(
            f"Agent {agent_id} reported {best}°F but expected "
            f"{expected}°F ± {tol} (error = {error:.2f})."
        ),
    )
