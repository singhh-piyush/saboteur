"""Telemetry event schema, async bus, JSONL writer, and WebSocket broadcaster.

Telemetry is the source of truth (CLAUDE.md invariant #3).
Build step 3 — to be implemented alongside the harness.

Planned modules:
    schema      — TelemetryEvent pydantic model
                  (ts, run_id, agent_id, step, event, fault, recovery,
                   tokens_used, latency_ms)
    bus         — async publish/subscribe; events fan out to all sinks
    writer      — JSONL sink, flush per event → runs/{run_id}.jsonl
    broadcaster — WebSocket sink → /ws/{run_id}
"""
