"""Fault interceptors, chaos profile loader, and seeded RNG.

Build step 2 — to be implemented after the scaffold is in place.

Planned modules:
    profile_loader  — loads YAML from profiles/ into a ChaosProfile pydantic model
    rng             — per-agent seeded random.Random(profile.seed + agent_id)
    interceptors    — wraps tool calls to inject api_error, rate_limit, malformed,
                      silent_lie, tool_vanish, latency, timeout, context_drop
"""
