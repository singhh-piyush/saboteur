"""Agent surface: mock tools, canonical task, and programmatic verifier.

Public API::

    from saboteur.agents import (
        GROUND_TRUTH, TASK_PROMPT,
        build_tools, FiledReport, ReportStore,
        WeatherTool, CalculatorTool, WebSearchTool, FileReportTool,
        verify, TaskResult, FailureReason,
    )
"""

from .task import GROUND_TRUTH, TASK_PROMPT
from .tools import (
    CalculatorTool,
    FiledReport,
    FileReportTool,
    ReportStore,
    WeatherTool,
    WebSearchTool,
    build_tools,
)
from .verifier import FailureReason, TaskResult, verify

__all__ = [
    "GROUND_TRUTH",
    "TASK_PROMPT",
    "build_tools",
    "FiledReport",
    "ReportStore",
    "WeatherTool",
    "CalculatorTool",
    "WebSearchTool",
    "FileReportTool",
    "verify",
    "TaskResult",
    "FailureReason",
]
