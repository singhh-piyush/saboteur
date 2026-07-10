"""Deterministic mock OpenAI-compatible server for offline inference.

Used by run --mock for offline/CI runs.
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

# silent_lie corrupts the last number (the °F), so the °C value stays true
_CELSIUS_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(?:°\s*C|degrees?\s+Celsius)", re.I)
_BARE_NUMBER_RE = re.compile(r"^\s*-?\d+(?:\.\d+)?\s*$")
# parse tool calls from flattened assistant text and observations
_NAME_RE = re.compile(r"""['"]name['"]\s*:\s*['"](\w+)['"]""")

# bounded retry budgets to allow failure in dense profiles rather than spinning
_MAX_WEATHER_TRIES = 2
_MAX_FILE_TRIES = 3
_FILED_MARKER = "Report filed successfully"


def _text_of(content: Any) -> str:
    # extract text from message content
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
    # count tool calls in assistant messages to avoid matching system prompt examples
    counts: Counter = Counter()
    for m in messages:
        if m.get("role") == "assistant":
            for name in _NAME_RE.findall(_text_of(m.get("content"))):
                counts[name] += 1
    return counts


def _last_observation(messages: list[dict]) -> str:
    # get text of the most recent observation user message
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
        name
        for t in (body.get("tools") or [])
        if isinstance((name := (t.get("function") or {}).get("name")), str)
    }


def decide(messages: list[dict], tools_available: set[str]) -> tuple[str, dict]:
    # decide next tool call from transcript, handling faults and fallbacks
    last = _last_observation(messages)
    full = _transcript(messages)
    counts = _called_counts(messages)

    # report is in; wrap up
    if _FILED_MARKER in full:
        return "final_answer", {"answer": "Tokyo weather report filed."}

    # happy path driven by most recent observation
    if not last:
        return "weather", {"city": "Tokyo"}
    if _BARE_NUMBER_RE.match(last):
        return "file_report", {"fahrenheit": last.strip()}
    c_last = _celsius(last)
    if c_last is not None:
        return "calculator", {"expression": f"{c_last} * 9 / 5 + 32"}

    # recovery for error, malformed, or missing observations
    prev_c = _celsius(full)

    # file_report was attempted but not confirmed; retry or fail
    if counts["file_report"] > 0:
        if counts["file_report"] < _MAX_FILE_TRIES and prev_c is not None:
            return "file_report", {"fahrenheit": _to_fahrenheit(prev_c)}
        return "final_answer", {"answer": "unable to file the report"}

    # calculator failed; compute fahrenheit manually
    if counts["calculator"] > 0 and prev_c is not None:
        return "file_report", {"fahrenheit": _to_fahrenheit(prev_c)}

    # weather failed; retry, search, or fail
    if "weather" in tools_available and counts["weather"] < _MAX_WEATHER_TRIES:
        return "weather", {"city": "Tokyo"}
    if "web_search" in tools_available and counts["web_search"] == 0:
        return "web_search", {"query": "Tokyo current temperature in Celsius"}
    return "final_answer", {"answer": "unable to determine Tokyo's temperature"}


def _completion(model: str, name: str, arguments: dict) -> dict:
    # return standard openai completion with one tool call
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
        # rough usage so token sums stay non-zero
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
