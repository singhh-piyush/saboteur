# BYO minimal agent

A ~40-line **raw OpenAI-SDK** agent (not smolagents) that Saboteur can sabotage
on the wire. It does a 2-tool task ("get Tokyo's temperature, convert to °F"),
prints `ANSWER: <value>` to stdout, and forwards the Saboteur attribution
headers for exact per-agent tracking when run as a spawned cohort.

## Zero code change: capture-all mode

The simplest path needs **no headers and no registration**. Start a capture run
(Targets page → "Sabotage my agent", or `POST /proxy/runs` with
`"capture_all": true`), then point *any* OpenAI-compatible agent at the proxy:

```bash
curl -X POST http://localhost:8000/proxy/runs -H 'content-type: application/json' \
  -d '{"profile": "hell_mode", "n_agents": 4, "capture_all": true}'

OPENAI_BASE_URL=http://localhost:8000/v1 python examples/byo_min_agent/agent.py
```

Headerless traffic is absorbed into the capture run: each new conversation
(a request with no assistant turn yet) becomes the next agent on the grid, and
follow-up requests attribute to the most recently started conversation. That
heuristic is right for one agent process at a time or sequential cohorts;
**concurrent** headerless agents will interleave — use the headers below for
exact attribution (they always win over capture).

## Exact attribution (headers — what the spawner uses)

1. Send chat requests to `OPENAI_BASE_URL` (the spawner points this at the proxy,
   e.g. `http://localhost:8000/v1`).
2. Forward two HTTP headers on every request, read from env:

   | env var              | header                  |
   | -------------------- | ----------------------- |
   | `SABOTEUR_RUN_ID`    | `X-Saboteur-Run-Id`     |
   | `SABOTEUR_AGENT_ID`  | `X-Saboteur-Agent-Id`   |

With the OpenAI SDK that's just `default_headers=` on the client (see `agent.py`,
or import `saboteur.proxy.shim.saboteur_client`). Without headers *and* without
an active capture run, the proxy is an untracked passthrough — no faults, no
telemetry.

## Run it standalone

```bash
OPENAI_BASE_URL=http://localhost:8080/v1 python examples/byo_min_agent/agent.py
# -> ANSWER: 71.6
```

## Run it as a sabotaged cohort

Start the stack (`scripts/run_local.sh` → llama.cpp on :8080 + the app on :8000),
then register this script as a `command` target and launch a cohort:

```bash
# Register (optionally attach a regex oracle so survival_rate populates).
curl -X POST http://localhost:8000/targets -H 'content-type: application/json' -d '{
  "name": "byo_min",
  "kind": "command",
  "cmd": ["python", "examples/byo_min_agent/agent.py"],
  "oracle": {"kind": "regex", "pattern": "71\\.6"}
}'

# Launch N=8 under hell_mode — watch the existing dashboard grid populate live
# from a non-smolagents agent.
curl -X POST http://localhost:8000/runs -H 'content-type: application/json' -d '{
  "target": "byo_min",
  "profile": "hell_mode",
  "n_agents": 8
}'
```

The scorecard shows the behavioral tier (MTTR, recovery breakdown, failure
modes, crash rate). With the regex oracle attached, `survival_rate` populates
too; `deception_detection_rate` stays `null` (BYO oracles aren't
deception-aware — that requires the reference ground-truth oracle).

> The cohort spawner runs arbitrary local commands from the target registry
> (the `targets` table in `runs/saboteur.db`) — by design, for this single-user
> local tool. Only register commands you trust.
