# BYO minimal agent

A ~40-line **raw OpenAI-SDK** agent (not smolagents) that Saboteur can sabotage
on the wire. It does a 2-tool task ("get Tokyo's temperature, convert to °F"),
prints `ANSWER: <value>` to stdout, and — crucially — forwards the Saboteur
attribution headers so the proxy can inject faults into *its* traffic.

## The contract (what any BYO agent must do)

1. Send chat requests to `OPENAI_BASE_URL` (the spawner points this at the proxy,
   e.g. `http://localhost:8000/v1`).
2. Forward two HTTP headers on every request, read from env:

   | env var              | header                  |
   | -------------------- | ----------------------- |
   | `SABOTEUR_RUN_ID`    | `X-Saboteur-Run-Id`     |
   | `SABOTEUR_AGENT_ID`  | `X-Saboteur-Agent-Id`   |

With the OpenAI SDK that's just `default_headers=` on the client (see `agent.py`,
or import `saboteur.proxy.shim.saboteur_client`). Without the headers the proxy
treats the request as an untracked passthrough — no faults, no telemetry.

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

> The cohort spawner runs arbitrary local commands from `runs/targets.json` — by
> design, for this single-user local tool. Only register commands you trust.
