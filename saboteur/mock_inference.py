"""Deterministic mock OpenAI-compatible server — offline inference for CI/demos.

Free GitHub runners (and laptops) have no GPU, but the resilience gate still
needs *some* model behind ``OPENAI_BASE_URL``. This is a tiny FastAPI app that
speaks just enough of the OpenAI chat-completions API to drive Saboteur's
reference :class:`~smolagents.ToolCallingAgent` through the canonical task
(``weather`` → ``calculator`` → ``file_report`` → ``final_answer``; see
``saboteur/agents/task.py`` + ``tools.py``).

It is **not** a smart model — it is a *fixed, credible policy* implemented as a
pure function of the request transcript. Crucially, the chaos engine still
injects the real faults at the tool-call boundary; the mock only reacts to the
resulting observations (errors, malformed text, the ``silent_lie`` °F decoy).
Because the policy is deterministic, the whole cohort becomes reproducible
(invariant #1's non-determinism caveat is about *real* LLMs), so the CI gate's
green/red is stable and the per-profile survival is knowable up front.

Run it:  ``uvicorn saboteur.mock_inference:app --port 9001``  then point
``OPENAI_BASE_URL=http://127.0.0.1:9001/v1`` (the ``saboteur run --mock`` flag
does this for you).
"""

from __future__ import annotations

import json
import re
import time
import uuid
from collections import Counter
from typing import Any

from fastapi import FastAPI, Request

app = FastAPI(title="Saboteur Mock Inference", version="0.1.0")

# A number immediately tagged as Celsius — "22.0°C" or "22 degrees Celsius".
# silent_lie corrupts the *last* number (the °F), so the °C value stays true and
# a policy that reads it resists the decoy (CLAUDE.md H1 design).
_CELSIUS_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(?:°\s*C|degrees?\s+Celsius)", re.I)
_BARE_NUMBER_RE = re.compile(r"^\s*-?\d+(?:\.\d+)?\s*$")
# smolagents flattens the transcript to text: the assistant renders prior calls
# as ``Calling tools: [{... 'name': 'weather' ...}]`` and tool results as
# ``Observation: <text>`` user messages. We parse that text (NOT structured
# ``tool_calls`` fields, which this model path does not send).
_NAME_RE = re.compile(r"""['"]name['"]\s*:\s*['"](\w+)['"]""")

# Retry/fallback budgets — bounded so dense profiles (hell_mode) can exhaust them
# and fail some agents (a real survival gradient), never spin to the step cap.
_MAX_WEATHER_TRIES = 2
_MAX_FILE_TRIES = 3
_FILED_MARKER = "Report filed successfully"


# ---------------------------------------------------------------------------
# Transcript parsing helpers (pure)
# ---------------------------------------------------------------------------


def _text_of(content: Any) -> str:
    """Extract text whether content is a str or a list of content parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            p.get("text", "") for p in content if isinstance(p, dict)
        )
    return ""


def _transcript(messages: list[dict]) -> str:
    return "\n".join(_text_of(m.get("content")) for m in messages)


def _called_counts(messages: list[dict]) -> Counter:
    """Count tool calls the assistant has already made, by tool name.

    Reads the flattened ``Calling tools: [{... 'name': X ...}]`` text of
    **assistant** messages only (the system prompt's worked examples also mention
    tool names, so they must be excluded).
    """
    counts: Counter = Counter()
    for m in messages:
        if m.get("role") == "assistant":
            for name in _NAME_RE.findall(_text_of(m.get("content"))):
                counts[name] += 1
    return counts


def _last_observation(messages: list[dict]) -> str:
    """Text of the most recent ``Observation:`` (a tool result), else ``""``.

    Tool results arrive as ``user`` messages prefixed ``Observation:``; the
    original task is a ``user`` message without that prefix, so it is never
    mistaken for an observation.
    """
    for m in reversed(messages):
        if m.get("role") in ("user", "tool"):
            txt = _text_of(m.get("content"))
            if "Observation:" in txt:
                return txt.rsplit("Observation:", 1)[1].strip()
    return ""


def _celsius(text: str) -> float | None:
    m = _CELSIUS_RE.search(text or "")
    return float(m.group(1)) if m else None


def _to_fahrenheit(celsius: float) -> str:
    f = round(celsius * 9 / 5 + 32, 1)
    return str(int(f) if f == int(f) else f)


def _tool_names(body: dict) -> set[str]:
    return {
        (t.get("function") or {}).get("name")
        for t in (body.get("tools") or [])
        if (t.get("function") or {}).get("name")
    }


# ---------------------------------------------------------------------------
# The policy (pure) — decide the next tool call from the transcript
# ---------------------------------------------------------------------------


def decide(messages: list[dict], tools_available: set[str]) -> tuple[str, dict]:
    """Return ``(tool_name, arguments)`` for the next step.

    Happy path: weather → calculator → file_report → final_answer. Reacts to
    chaos-corrupted observations: resists the °F decoy (reads °C), retries a
    transient weather fault, falls back to ``web_search`` when weather is gone,
    recomputes °F itself if the calculator is sabotaged, and gives up (→ a
    verifier failure) once bounded budgets are exhausted.
    """
    last = _last_observation(messages)
    full = _transcript(messages)
    counts = _called_counts(messages)

    # Terminal: the report is in — wrap up.
    if _FILED_MARKER in full:
        return "final_answer", {"answer": "Tokyo weather report filed."}

    # --- happy path, driven by the most recent observation ---
    if not last:  # nothing observed yet
        return "weather", {"city": "Tokyo"}
    if _BARE_NUMBER_RE.match(last):  # a calculator result
        return "file_report", {"fahrenheit": last.strip()}
    c_last = _celsius(last)
    if c_last is not None:  # a fresh weather/web_search reading
        return "calculator", {"expression": f"{c_last} * 9 / 5 + 32"}

    # --- recovery: the latest observation is an error / malformed / vanish ---
    prev_c = _celsius(full)  # a Celsius reading seen earlier, if any

    # file_report was attempted but never confirmed → it was sabotaged.
    if counts["file_report"] > 0:
        if counts["file_report"] < _MAX_FILE_TRIES and prev_c is not None:
            return "file_report", {"fahrenheit": _to_fahrenheit(prev_c)}
        return "final_answer", {"answer": "unable to file the report"}

    # calculator was attempted but produced no number → sabotaged; do the math.
    if counts["calculator"] > 0 and prev_c is not None:
        return "file_report", {"fahrenheit": _to_fahrenheit(prev_c)}

    # No usable Celsius yet → weather failed. Retry, then fall back, then give up.
    if "weather" in tools_available and counts["weather"] < _MAX_WEATHER_TRIES:
        return "weather", {"city": "Tokyo"}
    if "web_search" in tools_available and counts["web_search"] == 0:
        return "web_search", {"query": "Tokyo current temperature in Celsius"}
    return "final_answer", {"answer": "unable to determine Tokyo's temperature"}


# ---------------------------------------------------------------------------
# OpenAI response shaping
# ---------------------------------------------------------------------------


def _completion(model: str, name: str, arguments: dict) -> dict:
    """A standard OpenAI chat.completion carrying exactly one tool call."""
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": f"call_{uuid.uuid4().hex[:8]}",
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        # Rough usage so token sums (waste_factor) stay non-zero; survival/MTTR
        # do not depend on these numbers.
        "usage": {"prompt_tokens": 64, "completion_tokens": 16, "total_tokens": 80},
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": "saboteur-mock"}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": "saboteur-mock", "object": "model", "owned_by": "saboteur"}],
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: Request) -> dict:
    body = await req.json()
    model = body.get("model", "saboteur-mock")
    messages = body.get("messages") or []
    name, arguments = decide(messages, _tool_names(body))
    return _completion(model, name, arguments)
