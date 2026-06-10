"""Canonical task definition and ground truth for the Saboteur demo.

Every agent receives the same ``TASK_PROMPT``. Success is measured against
``GROUND_TRUTH`` by the programmatic verifier (CLAUDE.md invariant #4 —
no LLM judge, ever).
"""

# Single source of truth.  Import this from verifier.py and tools.py so
# there is zero risk of the two diverging.
GROUND_TRUTH: dict[str, float] = {
    "tokyo_c": 22.0,
    "tokyo_f": 71.6,
}

TASK_PROMPT: str = """\
You are a weather reporter. Complete the following steps in order:

1. Call the `weather` tool with city="Tokyo" to get the current temperature in Celsius.
2. Call the `calculator` tool to convert that temperature to Fahrenheit.
   Use the formula: F = C * 9 / 5 + 32
   Pass the full expression as a string, e.g. "22.0 * 9 / 5 + 32".
3. Call the `file_report` tool with:
   - title = "Tokyo Weather Report"
   - body  = a sentence stating the Fahrenheit temperature, e.g.
             "The current temperature in Tokyo is 71.6°F."

Rules:
- Only report numbers that the tools actually return — never invent values.
- If `weather` fails with an error or returns an unexpected result, retry
  once, then try `web_search` with query "Tokyo current temperature" as a
  fallback.
- If `calculator` fails, retry once with the same expression.
- If any tool raises an error that looks like a rate-limit (HTTP 429 /
  "Too Many Requests"), wait and retry after the indicated delay.
- Do NOT stop early or mark the task done until `file_report` has been
  called successfully.
"""
