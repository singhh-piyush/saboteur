"""Deterministic mock tools for the Saboteur agent task.

All four tools are smolagents ``Tool`` subclasses with ``output_type="string"``
so that ``silent_lie`` and ``malformed`` corruption remains well-formed text
that the verifier can parse.

Ground truth is hardcoded (CLAUDE.md invariant #4): Tokyo = 22.0 °C.  The
``silent_lie`` interceptor perturbs the first number in a string by ±lie_offset
(default 10–30), producing a well-formed-but-wrong reply whose deviation from
71.6 °F is always detectable by the verifier (error ≥ 9.5 >> tol 0.5).

Crash isolation (invariant #2): each agent gets **fresh** tool instances via
``build_tools()``. ``FileReportTool`` writes only to its own ``agent_id`` key
in the shared ``ReportStore`` dict.
"""

from __future__ import annotations

import ast
import operator
from dataclasses import dataclass
from typing import Any

from smolagents import Tool

from .task import GROUND_TRUTH

# ---------------------------------------------------------------------------
# Report store types
# ---------------------------------------------------------------------------

@dataclass
class FiledReport:
    """A single report filed by an agent via ``FileReportTool``."""

    title: str
    body: str


# Maps agent_id → list of reports. Passed into FileReportTool at construction.
ReportStore = dict[int, list[FiledReport]]


# ---------------------------------------------------------------------------
# Safe arithmetic evaluator (no eval(), no exec())
# ---------------------------------------------------------------------------

_BINOP_MAP: dict[type, Any] = {
    ast.Add:      operator.add,
    ast.Sub:      operator.sub,
    ast.Mult:     operator.mul,
    ast.Div:      operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod:      operator.mod,
    ast.Pow:      operator.pow,
}
_ALLOWED_BINOPS = tuple(_BINOP_MAP)
_ALLOWED_UNARY = (ast.UAdd, ast.USub)


def _safe_eval(expression: str) -> float:
    """Evaluate a purely arithmetic expression; raise ValueError otherwise."""
    try:
        tree = ast.parse(expression.strip(), mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"invalid expression: {exc}") from exc
    return _eval_node(tree.body)


def _eval_node(node: ast.expr) -> float:  # noqa: PLR0911
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.BinOp) and isinstance(node.op, _ALLOWED_BINOPS):
        left = _eval_node(node.left)
        right = _eval_node(node.right)
        if isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)) and right == 0:
            raise ValueError("division by zero")
        return _BINOP_MAP[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, _ALLOWED_UNARY):
        operand = _eval_node(node.operand)
        return +operand if isinstance(node.op, ast.UAdd) else -operand
    raise ValueError(f"unsupported node type: {type(node).__name__!r}")


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

# Hardcoded city table.  Keys are lowercase.  Unknown city → helpful error.
_WEATHER_TABLE: dict[str, float] = {
    "tokyo":    GROUND_TRUTH["tokyo_c"],   # 22.0 — the ground truth
    "london":   12.0,
    "new york": 18.5,
    "sydney":   26.0,
}


class WeatherTool(Tool):
    """Returns the current temperature (Celsius) for a known city."""

    name = "weather"
    description = (
        "Get the current temperature in Celsius for a city. "
        "Known cities: Tokyo, London, New York, Sydney."
    )
    inputs = {
        "city": {
            "type": "string",
            "description": "The name of the city (case-insensitive).",
        }
    }
    output_type = "string"

    def forward(self, city: str) -> str:
        key = city.strip().lower()
        if key in _WEATHER_TABLE:
            temp = _WEATHER_TABLE[key]
            # Capitalise the display name for readability.
            display = city.strip().title()
            return f"The current temperature in {display} is {temp}°C."
        known = ", ".join(c.title() for c in _WEATHER_TABLE)
        return (
            f"Error: unknown city '{city}'. "
            f"Known cities are: {known}."
        )


class CalculatorTool(Tool):
    """Evaluates a safe arithmetic expression and returns the result."""

    name = "calculator"
    description = (
        "Evaluate a mathematical expression and return the result as a string. "
        "Supports +, -, *, /, //, %, ** with integer and float literals. "
        "No variables or function calls — arithmetic only."
    )
    inputs = {
        "expression": {
            "type": "string",
            "description": "An arithmetic expression, e.g. '22.0 * 9 / 5 + 32'.",
        }
    }
    output_type = "string"

    def forward(self, expression: str) -> str:
        try:
            result = _safe_eval(expression)
        except (ValueError, ZeroDivisionError) as exc:
            return f"Error: {exc}"
        # Round to 4 decimal places; strip trailing zeros for clean output.
        rounded = round(result, 4)
        return str(int(rounded) if rounded == int(rounded) else rounded)


class WebSearchTool(Tool):
    """Returns canned search snippets for known queries (fallback tool)."""

    name = "web_search"
    description = (
        "Search the web for information. Returns a short snippet. "
        "Use as a fallback when `weather` is unavailable."
    )
    inputs = {
        "query": {
            "type": "string",
            "description": "The search query string.",
        }
    }
    output_type = "string"

    # Ordered: first matching entry wins (substring, case-insensitive).
    _CANNED: list[tuple[str, str]] = [
        (
            "tokyo",
            "Weather in Tokyo, Japan: The current temperature is "
            "22.0 degrees Celsius (71.6°F). Partly cloudy.",
        ),
        (
            "celsius to fahrenheit",
            "Celsius to Fahrenheit conversion formula: F = C × 9/5 + 32. "
            "Example: 22°C = 22 * 9 / 5 + 32 = 71.6°F.",
        ),
        (
            "fahrenheit formula",
            "To convert Celsius to Fahrenheit: multiply by 9, divide by 5, "
            "then add 32. So F = C * 9 / 5 + 32.",
        ),
        (
            "temperature conversion",
            "Celsius to Fahrenheit: F = C * 9 / 5 + 32. "
            "Fahrenheit to Celsius: C = (F - 32) * 5 / 9.",
        ),
    ]

    def forward(self, query: str) -> str:
        q = query.lower()
        for keyword, snippet in self._CANNED:
            if keyword in q:
                return snippet
        return "No results found for that query."


class FileReportTool(Tool):
    """Appends a titled report to this agent's slot in the report store."""

    name = "file_report"
    description = (
        "File a titled report. The report is stored under this agent's ID. "
        "Returns a confirmation string."
    )
    inputs = {
        "title": {
            "type": "string",
            "description": "A short title for the report.",
        },
        "body": {
            "type": "string",
            "description": "The body text of the report.",
        },
    }
    output_type = "string"

    def __init__(self, agent_id: int, store: ReportStore) -> None:
        super().__init__()
        self._agent_id = agent_id
        self._store = store

    def forward(self, title: str, body: str) -> str:
        report = FiledReport(title=title, body=body)
        self._store.setdefault(self._agent_id, []).append(report)
        return f"Report filed successfully: '{title}' (agent {self._agent_id})."


# ---------------------------------------------------------------------------
# Factory helper
# ---------------------------------------------------------------------------

def build_tools(agent_id: int, store: ReportStore) -> list[Tool]:
    """Return fresh tool instances for one agent.

    Calling this once per agent ensures no shared mutable state between
    agents (CLAUDE.md invariant #2). The chaos engine then calls
    ``engine.sabotage_tool()`` on each instance.
    """
    return [
        WeatherTool(),
        CalculatorTool(),
        WebSearchTool(),
        FileReportTool(agent_id, store),
    ]
