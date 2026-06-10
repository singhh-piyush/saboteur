"""Agent surface: mock tools, canonical task, and programmatic verifier.

Public API::

    from saboteur.agents import (
        GROUND_TRUTH, TASK_PROMPT,
        build_tools, FiledReport, ReportStore,
        WeatherTool, CalculatorTool, WebSearchTool, FileReportTool,
        verify, TaskResult, FailureReason,
        build_agent, SaboteurAgent,
        Outcome, RecoveryKind, RecoveryEvent, AgentRunResult, AgentEvent,
        StepRecord, classify_outcome, classify_recoveries,
    )
"""

from .factory import RESILIENCE_INSTRUCTIONS, SaboteurAgent, build_agent
from .outcomes import (
    AgentEvent,
    AgentRunResult,
    Outcome,
    RecoveryEvent,
    RecoveryKind,
    StepRecord,
    classify_outcome,
    classify_recoveries,
)
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
    # Factory + instrumentation (WP4)
    "build_agent",
    "SaboteurAgent",
    "RESILIENCE_INSTRUCTIONS",
    "Outcome",
    "RecoveryKind",
    "RecoveryEvent",
    "AgentRunResult",
    "AgentEvent",
    "StepRecord",
    "classify_outcome",
    "classify_recoveries",
]
