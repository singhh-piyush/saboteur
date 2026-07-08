# Saboteur

Chaos testing for AI agents.

## What it is

AI agents look great in demos. In production, things break. APIs return 500s,
rate limits kick in, tool responses come back mangled, and context gets lost.
A lot of agents fall apart when that happens: they loop on retries, invent
results, or quietly give up.

There is no standard way to find this out before you ship. Saboteur is that
test. It runs your agent while deliberately breaking things around it, watches
how the agent reacts, and gives you a scorecard of how well it recovers.

Think Chaos Monkey, but for agents.

## How it works

1. You pick a chaos profile: a named set of faults with a fixed random seed.
   The seed matters. Given the same seed and the same sequence of calls, the
   same fault decisions fire, so runs can be repeated and compared.
2. Saboteur launches a cohort: N copies of the same agent, all given the same
   task at the same time, all under the same profile.
3. Every fault, tool call, recovery, and crash is written to an event log and
   streamed to a live dashboard. You watch the whole cohort as a grid: green
   is healthy, amber is recovering, red is crashed, cyan finished and passed.
4. When the cohort ends you get a Resilience Scorecard, computed purely from
   the event log. Because the log is the source of truth, replaying a saved
   run renders exactly what the live run looked like.

## The faults

Eight faults across three layers:

Tool layer

- `api_error`: the call fails with a 500 or 503
- `rate_limit`: a 429 with a Retry-After header
- `malformed`: the response comes back truncated or broken
- `silent_lie`: the response is well formed but the data is wrong
- `tool_vanish`: a tool disappears mid-run and stays gone

Transport layer

- `latency`: calls get slow
- `timeout`: calls hang and then fail

Context layer

- `context_drop`: the agent loses the last few steps of its memory

Profiles combine these. `calm_seas` has no faults (it is the control),
`flaky_friday` and `rate_limit_storm` are moderate, `liars_den` isolates the
deception test, and `hell_mode` turns on all eight.

## Quick start (no GPU needed)

You need Python 3.11+ and Node 20+ (Node only builds the dashboard).

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cd frontend && npm ci && npm run build && cd ..
```

Run a full cohort offline. The `--mock` flag boots a small deterministic mock
model that plays the agent's role, so nothing needs a GPU or an API key:

```bash
saboteur run --target reference --profile hell_mode --control --mock
```

This runs a calm control cohort, then a hell_mode cohort, and prints the
scorecard. Artifacts land in `runs/{run_id}.jsonl` and
`runs/{run_id}.scorecard.json`.

Useful commands:

```bash
saboteur profiles          # list the chaos profiles
saboteur targets           # list registered agents under test
saboteur compare A B       # per-metric delta between two runs
saboteur run --help        # all the knobs
```

## Docker

The same offline mock cohort runs in a container, so nothing but Docker is
needed to try it:

```bash
docker build -t saboteur .
docker run --rm -v "$PWD/runs:/app/runs" saboteur \
  run --target reference --profile hell_mode --control --mock
```

For the full console (API + dashboard + proxy in one container), inference
stays on the host, so the only host process is llama-server, and it must bind
0.0.0.0 so the container can reach it:

```bash
llama-server -m /path/to/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 -c 32768 -np 8 --jinja

make up                        # build and start, waits for /health
make run                       # POST a reference cohort (PROFILE=hell_mode make run)
make logs                      # follow container logs
make down                      # stop; runs/ persists on the host
```

`runs/` is bind-mounted, so history survives restarts. The SQLite run index
is just a cache and rebuilds itself from the JSONL logs on startup.

To point the container at a remote vLLM endpoint instead of local llama.cpp,
edit `compose.env` and bring it up again. No rebuild.

## Using a real model

Local development uses llama.cpp. The `--jinja` flag is required (it enables
OpenAI-style tool calls) and `-np 8` gives the 8 parallel slots the local
cohort uses:

```bash
llama-server -m ./models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 -c 32768 -np 8 --jinja
```

The defaults already point at `http://localhost:8080/v1`. To use a different
endpoint or model, copy `.env.example` to `.env` and edit it. Swapping from a
local 8B to a big vLLM box is a config change, never a code change.

## The console

The API, the chaos proxy, and the dashboard all run in one process on one
port:

```bash
bash scripts/run_local.sh
# or just the app: .venv/bin/uvicorn saboteur.api:app --reload --port 8000
```

Open http://localhost:8000. From the UI you can launch runs, watch the live
grid, inspect any agent's step-by-step trace, read scorecards, build custom
chaos profiles, and manage past runs. The dashboard also ships a guided
walkthrough built from four real 50-agent hell_mode runs captured on an AMD
MI300X, so there is something to watch before you launch anything.

Paths worth knowing: the chaos proxy lives at `/v1` (the standard OpenAI base
path), run management at `/proxy/*`, the REST API at `/runs`, `/profiles`,
`/targets` and `/faults`, and live telemetry at `/ws/{run_id}`.

## Testing your own agent

Saboteur can sabotage an agent it does not own by sitting between the agent
and its model. The proxy speaks the OpenAI wire protocol, injects faults into
the traffic, and forwards everything else untouched.

The simplest way needs one env var and zero code changes. Start a capture run
(on the Targets page there is a "Sabotage my agent" card, or use curl):

```bash
curl -X POST localhost:8000/proxy/runs -H 'content-type: application/json' \
  -d '{"profile": "hell_mode", "n_agents": 4, "capture_all": true}'
```

Then point your agent at the proxy and run it as usual:

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 python your_agent.py
```

Each new conversation your agent starts becomes the next cell on the grid.
When you are done, stop the run from the UI (or it finishes itself after
going idle) and the scorecard is written.

If you run many agent copies at once, add two headers so each one is tracked
exactly: `X-Saboteur-Run-Id` and `X-Saboteur-Agent-Id`. Headers always take
priority over capture mode.

You can also register your agent as a target (a command Saboteur runs as a
subprocess) and let it launch the whole cohort for you, including a success
oracle that decides pass or fail. A working 40-line example using the raw
OpenAI SDK lives in `examples/byo_min_agent/`.

Agents that talk to tools over MCP get the same treatment. `saboteur-mcp` is
a stdio shim: point your MCP client at it instead of your real server, tell
it the real server's command after `--`, and it relays the JSON-RPC while
injecting the tool-layer faults into `tools/call` results:

```bash
saboteur-mcp --run <run_id> --agent 0 --profile hell_mode -- python real_server.py
```

Telemetry is posted to the dashboard, so MCP runs land on the same grid. No
client code changes.

## The scorecard

Two kinds of metrics, and Saboteur is strict about the difference.

Behavioral metrics are always computed, because they need no ground truth:

- mean time to recovery, in steps from a fault to the next productive action
- recovery breakdown: retried, reformulated the call, fell back to another
  tool, stalled, or gave up
- waste factor: tokens burned under chaos versus the calm control run
- crash rate and a histogram of failure modes (infinite retry, timeout,
  silent abandonment, hard exception)

Verdict metrics need a way to check the answer, so they only appear when one
exists:

- survival rate: the share of agents that finished with a correct result
- deception detection rate: the share that caught the planted lie instead of
  repeating it

For Saboteur's own reference task the check is a hardcoded verifier (Tokyo is
22.0 C, which is 71.6 F, and the report must say so). For your agent you
supply the check: a regex over the final output, a command that exits 0 on
success, or an HTTP callback. There is no LLM judge anywhere, on purpose. If
no check ran, those metrics are null with a reason attached rather than a
made-up number.

## Replaying runs

Every run's event log can re-drive the dashboard, no model needed. A recorded
hell_mode run ships in the repo:

```bash
saboteur replay runs/hell_mode-20260629T231833-2b225c.jsonl --speed 2.0 --follow
```

The grid and scorecard render identically to the original live run, because
both are pure functions of the same event log.

## CI gate

Saboteur ships as a GitHub Action, so agent resilience can be a required
check on every PR. It fails the check when a metric crosses your threshold
and comments the per-metric delta against the base branch's last run.

```yaml
# .github/workflows/resilience.yml (a working copy lives in this repo)
permissions: { contents: read, pull-requests: write, actions: read }
jobs:
  resilience:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/saboteur-resilience
        with:
          target: reference
          profile: hell_mode
          metric: survival_rate
          threshold: "0.85"   # raise to "0.95" to watch it block the merge
          mock: "true"        # offline demo; set "false" to use your endpoint
```

Out of the box it runs offline against the bundled mock model, so the sample
workflow is green or red with no GPU and no secrets. To gate your own agent,
set `mock: "false"` and pass `openai-base-url`, `openai-api-key` and
`model-id` from repo secrets.

The gate is direction-aware: survival fails when it drops below the
threshold, crash rate fails when it rises above it. The same gate works in a
shell:

```bash
saboteur run --target reference --mock --profile hell_mode \
  --ci --metric survival_rate --threshold 0.85
# exit 0 = pass, 1 = threshold breached, 2 = misconfigured gate
```

## Tests

```bash
make test                      # backend (pytest)
make lint                      # ruff + mypy
cd frontend && npx vitest run  # dashboard tests
```

The test suite covers the things that matter most here: fault sequences are
byte-identical for the same seed, one agent's crash can never touch another,
and re-scoring a saved event log always matches the scorecard that was
written live.

## Built with

- smolagents for the reference agent loop
- FastAPI and asyncio for the orchestrator and proxy
- React, Vite and Tailwind for the dashboard
- llama.cpp for local development
- vLLM on ROCm with an AMD Instinct MI300X for the 50-agent cohort runs

Built for the AMD Developer Hackathon: ACT II.
