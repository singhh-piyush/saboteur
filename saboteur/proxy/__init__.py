"""Wire-level chaos proxy.

A FastAPI router (mounted on the dashboard app) that speaks the OpenAI Chat
Completions API, injects the 8-fault taxonomy on the wire, forwards to the real
upstream, and emits the same ``TelemetryEvent`` schema as the cohort path — so
the existing grid / scorecard / replay work unchanged. This lets Saboteur test
**agents we do not own**: point the agent's ``OPENAI_BASE_URL`` at the proxy.

Only the *injection mechanism* (HTTP instead of a Python tool call) is new; all
fault decisions reuse the chaos core (``ChaosRandom``, profiles, interceptors).
"""

from .router import router as proxy_router

# Exported as ``proxy_router`` (not ``router``) so the ``router`` submodule
# isn't shadowed by a same-named package attribute.
__all__ = ["proxy_router"]
