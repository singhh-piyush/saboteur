"""Battle-royale runner, per-agent instrumentation, and scorecard computation.

Build step 3 — to be implemented after agents and chaos engine are ready.

Planned modules:
    battle_royale   — asyncio.gather(..., return_exceptions=True) over N agents;
                      each agent loop runs via asyncio.to_thread (smolagents is sync)
    instrumentation — wraps the agent loop to emit telemetry events
    scoring         — pure function over event stream → ResilienceScorecard
"""
