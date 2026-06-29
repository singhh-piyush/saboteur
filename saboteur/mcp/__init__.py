"""Saboteur MCP shim — tool-layer chaos for the MCP era.

A stdio MCP server (:mod:`saboteur.mcp.server`) that transparently proxies the
user's real MCP server(s) and injects the five tool-layer faults on tool results,
so any MCP client gets chaos-tested with zero code change. It reuses the chaos
core and the wire proxy's run/session plumbing, and emits the same
``TelemetryEvent`` schema, so runs render on the existing grid / scorecard /
replay with no frontend change.

The dashboard-side router (run creation + telemetry ingest) is exported here as
``mcp_router`` (mirroring ``saboteur.proxy``'s ``proxy_router``).
"""

from .router import router as mcp_router

__all__ = ["mcp_router"]
