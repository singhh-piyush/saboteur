# mcp_min_server — a trivial upstream for the Saboteur MCP shim

A ~60-line, dependency-free MCP server (stdio transport) used to demonstrate and
test the **Saboteur MCP shim** (`saboteur/mcp`). It exposes two tools:

- `get_weather(city)` → `"22.0°C (71.6°F)"` for Tokyo — the deception
  ground-truth (Saboteur's `silent_lie` lies only the derived °F, leaving °C
  true).
- `add(a, b)` → the numeric sum.

## How the shim wraps it

The shim is a **man-in-the-middle MCP server**: your MCP client launches the
shim; the shim launches *this* server, relays JSON-RPC between them, and injects
the five tool-layer faults (`latency`, `rate_limit`, `tool_vanish`, `malformed`,
`silent_lie`) on tool results per the active chaos profile. Your client needs
**zero code change** — only its config points at `saboteur-mcp` instead of this
server directly.

```
MCP client ──stdio──▶ saboteur-mcp (shim) ──stdio──▶ examples/mcp_min_server
                          │
                          └─ POST telemetry ─▶ Saboteur dashboard (grid/scorecard)
```

## Register a chaos run, then point a client at the shim

1. Start the Saboteur dashboard app (so telemetry renders live):

   ```bash
   uvicorn saboteur.api:app --port 8000
   ```

2. Create an MCP run and grab the `run_id`:

   ```bash
   curl -s -XPOST localhost:8000/mcp/runs \
     -H 'content-type: application/json' \
     -d '{"profile":"hell_mode","n_agents":1}'
   # → {"run_id":"hell_mode-…","seed":666}
   ```

3. Configure your MCP client to launch the shim (example: a `claude_desktop_config.json`
   style entry). The shim wraps this server (everything after `--`):

   ```json
   {
     "mcpServers": {
       "weather-under-chaos": {
         "command": "saboteur-mcp",
         "args": ["--profile", "hell_mode", "--run", "hell_mode-…", "--agent", "0",
                  "--", "python", "examples/mcp_min_server/server.py"],
         "env": { "SABOTEUR_INGEST_URL": "http://localhost:8000" }
       }
     }
   }
   ```

   (Flags can also come from env: `SABOTEUR_PROFILE`, `SABOTEUR_RUN_ID`,
   `SABOTEUR_AGENT_ID`, `SABOTEUR_UPSTREAM`.) With no `--run`/`--profile` the shim
   is a transparent passthrough.

4. Use the tools from your client. Under `hell_mode` you'll see corrupted /
   dropped / delayed results; under `calm_seas` the shim is a faithful
   passthrough. The run renders on the dashboard grid and gets a scorecard.

For a self-contained live demo (no MCP client needed), run
`python scripts/mcp_smoke.py`.
