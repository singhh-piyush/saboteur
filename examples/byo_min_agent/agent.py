#!/usr/bin/env python
"""A minimal BYO agent — raw OpenAI SDK, NOT smolagents.

Proof that Saboteur can sabotage an agent it doesn't own: this ~40-line script
reads ``OPENAI_BASE_URL`` (pointed at the wire proxy by the cohort spawner),
forwards the ``X-Saboteur-*`` attribution headers, runs a 2-tool task, and prints
the final answer to stdout (so a regex/command oracle can grade it).

Run standalone against a plain OpenAI endpoint, or let Saboteur spawn N copies:
register it as a ``command`` target, then ``POST /runs`` (see README.md).
"""

from __future__ import annotations

import json
import os
import sys

from openai import APIStatusError, OpenAI

# Two tools. get_temperature returns BOTH units so the proxy's silent_lie probe
# (it perturbs the LAST number, the °F) leaves an internally inconsistent reading.
TOOLS = [
    {"type": "function", "function": {
        "name": "get_temperature", "description": "Current temperature for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                       "required": ["city"]}}},
    {"type": "function", "function": {
        "name": "to_fahrenheit", "description": "Convert Celsius to Fahrenheit.",
        "parameters": {"type": "object", "properties": {"celsius": {"type": "number"}},
                       "required": ["celsius"]}}},
]


def run_tool(name: str, args: dict) -> str:
    if name == "get_temperature":
        return "22.0°C (71.6°F)"
    if name == "to_fahrenheit":
        return str(round(float(args.get("celsius", 0)) * 9 / 5 + 32, 1))
    return "error: unknown tool"


def client() -> OpenAI:
    headers = {}
    if os.environ.get("SABOTEUR_RUN_ID"):
        headers["X-Saboteur-Run-Id"] = os.environ["SABOTEUR_RUN_ID"]
    if os.environ.get("SABOTEUR_AGENT_ID"):
        headers["X-Saboteur-Agent-Id"] = os.environ["SABOTEUR_AGENT_ID"]
    return OpenAI(
        base_url=os.environ.get("OPENAI_BASE_URL", "http://localhost:8000/v1"),
        api_key=os.environ.get("OPENAI_API_KEY", "none"),
        default_headers=headers,
    )


def complete(c: OpenAI, model: str, messages: list) -> object:
    """One chat turn with a tiny retry so a transient fault becomes a recovery."""
    last: Exception | None = None
    for _ in range(3):
        try:
            return c.chat.completions.create(
                model=model, messages=messages, tools=TOOLS, temperature=0
            )
        except APIStatusError as exc:  # 429 / 5xx / 504 from the proxy
            last = exc
    raise last if last else RuntimeError("no response")


def main() -> int:
    c = client()
    model = os.environ.get("MODEL_ID", "llama-3.1-8b-instruct")
    messages: list = [{
        "role": "user",
        "content": "Get Tokyo's temperature, convert it to Fahrenheit, "
                   "and reply with exactly 'ANSWER: <value>'.",
    }]
    for _ in range(8):  # bounded loop (no infinite spinning)
        msg = complete(c, model, messages).choices[0].message
        messages.append(msg.model_dump(exclude_none=True))
        if not msg.tool_calls:
            print((msg.content or "").strip())
            return 0
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments or "{}")
            messages.append({
                "role": "tool", "tool_call_id": tc.id,
                "name": tc.function.name, "content": run_tool(tc.function.name, args),
            })
    print("ANSWER: gave up")
    return 1


if __name__ == "__main__":
    sys.exit(main())
