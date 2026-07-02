# Saboteur

Chaos testing for AI agents.

## What is this?

AI agents look great in demos. In production, things break. APIs return errors, rate limits kick in, responses come back broken, and context gets lost. Many agents cannot handle this. They get stuck in retry loops, make up fake results, or quietly give up.

Right now there is no standard way to test how an agent handles failure before you ship it. Saboteur fixes that.

Saboteur runs your agent and breaks things on purpose. It injects faults like API errors, rate limits, slow responses, corrupted data, and lost memory, then watches what the agent does. Does it retry? Back off? Find another way? Or does it crash?

Think of it as a Chaos Monkey, but for AI agents.

## How it works

1. You pick a chaos profile: a named, seeded set of faults. Same seed means the same faults every time, so runs can be repeated and compared.
2. Saboteur spawns many identical agents at once and gives them all the same task while the faults hit them.
3. A live dashboard shows every agent in a grid: who is healthy, who is recovering, who crashed, and who finished.
4. At the end you get a Resilience Scorecard: survival rate, recovery time, wasted tokens, and a breakdown of how each agent failed or recovered.

## The fault types

- API errors (500s and 503s)
- Rate limits (429 with Retry-After)
- Timeouts and slow responses
- Malformed tool output
- Silent lies: tool output that looks correct but is wrong
- Context drops: the agent loses part of its memory
- Vanishing tools: a tool disappears in the middle of a run

## Run it locally (no Docker)

**Install** (Python 3.11+; Node 20+ only to build the dashboard):

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cd frontend && npm ci && npm run build && cd ..   # the console UI
```

**Inference** — two ways to drive agents:

- **Offline mock** (no GPU, no secrets): add `--mock` to any `saboteur run`
  command below. It boots a bundled deterministic mock model, runs, and tears
  it down — cohorts are reproducible.
- **Real local LLM** (llama.cpp). `--jinja` is required for tool calls; `-np 8`
  provides the parallel slots for the local N=8 cohort cap:

  ```bash
  llama-server -m ./models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
    --host 0.0.0.0 --port 8080 -c 32768 -np 8 --jinja
  ```

`.env` is optional for local dev (defaults target `http://localhost:8080/v1`);
copy `.env.example` to change the model or endpoint — the swap is pure config.

**Start the console** (orchestrator API + wire chaos proxy + dashboard, one port):

```bash
bash scripts/run_local.sh   # starts llama-server if down, then uvicorn on :8000
# or, app only:  .venv/bin/uvicorn saboteur.api:app --reload --port 8000
```

Open **http://localhost:8000**. The chaos proxy is mounted at `/v1` (the
standard OpenAI base path), run management at `/proxy/*`, the REST API at
`/runs` / `/profiles` / `/targets`, live telemetry at `/ws/{run_id}`.

**Run a cohort:**

```bash
# Saboteur's own reference agent (control + chaos), fully offline:
saboteur run --target reference --profile hell_mode --control --mock

# Sabotage YOUR agent with zero code change: start a capture run on the
# Targets page ("Sabotage my agent") — or:
#   curl -X POST localhost:8000/proxy/runs -H 'content-type: application/json' \
#     -d '{"profile": "hell_mode", "n_agents": 4, "capture_all": true}'
# — then just repoint your agent:
OPENAI_BASE_URL=http://localhost:8000/v1 python your_agent.py
```

Artifacts land in `runs/{run_id}.jsonl` + `runs/{run_id}.scorecard.json`.
`saboteur profiles` lists the chaos profiles (calm_seas, flaky_friday,
rate_limit_storm, liars_den, hell_mode); `saboteur compare A B` prints the
per-metric delta between two runs. For registered subprocess cohorts with a
success oracle (survival rate for an agent you don't own), see
`examples/byo_min_agent/`.

**Replay the bundled golden run** — re-drives the dashboard from a recorded
JSONL with all inference offline (the app must be up):

```bash
saboteur replay runs/hell_mode-20260629T231833-2b225c.jsonl --speed 2.0 --follow
```

**Tests:** `make test` (backend), `make lint` (ruff + mypy),
`cd frontend && npx vitest run` (reducer parity).

## CI gate: block the merge if resilience drops

Saboteur ships as a GitHub Action so resilience becomes a required check —
chaos-test the agent on every PR, fail the merge when a metric breaches its
threshold (direction-aware: survival fails below it, crash rate above it), and
comment the per-metric delta vs the base branch's last run.

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
          mock: "true"        # offline demo; set "false" + pass your endpoint
```

It runs **offline** out of the box: a bundled deterministic mock model
(`saboteur/mock_inference.py`) drives the real agent with no GPU or secrets, so
the demo is green/red and reproducible. To gate **your** agent, set
`mock: "false"` and pass `openai-base-url` / `openai-api-key` / `model-id`
(from repo secrets). The same gate runs locally via the CLI or Docker:

```bash
saboteur run --target reference --mock --profile hell_mode --ci --threshold 0.85
# or in CI's container:
docker build -t saboteur:ci . && docker run --rm -v "$PWD/runs:/app/runs" \
  saboteur:ci run --target reference --mock --profile hell_mode --ci --threshold 0.85
```

## Built with

- smolagents for the agent loop
- FastAPI and Python asyncio for the orchestrator
- React, Vite, and Tailwind for the dashboard
- vLLM on ROCm with an AMD Instinct MI300X for running 50 agents at the same time
- llama.cpp for local development

Built for the AMD Developer Hackathon: ACT II.

## Run it with Docker

The whole console (orchestrator API + wire-level chaos proxy + dashboard) runs in
one container. Inference stays on the host (llama.cpp), so the only thing you run
outside Docker is `llama-server`.

**1. Start the host llama-server** (the only host process). It **must** bind
`0.0.0.0` so the container can reach it — the default `127.0.0.1` is unreachable
from inside Docker:

```bash
llama-server -m /path/to/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 -c 32768 -np 8 --jinja
```

(`--jinja` enables tool calling; `-np 8` gives 8 parallel slots for the N=8 cohort.
One-time GGUF download instructions are in `scripts/run_local.sh`.)

**2. Bring up the console:**

```bash
make up                 # = docker compose --env-file compose.env up --build -d
```

**3. Open the dashboard** at **http://localhost:8000** and launch a run from the UI,
or fire a reference cohort from the CLI:

```bash
make run                # POST a reference flaky_friday cohort
# or pick a profile:  PROFILE=hell_mode make run
```

Watch the agent grid animate live; the Resilience Scorecard renders when the cohort
finishes. Event logs + scorecards land in `./runs/` on the host.

```bash
make logs               # follow container logs
make down               # stop the container (runs/ persists on the host)
```

`runs/` is bind-mounted, so history survives `make down` / `make up` (the SQLite
index is rebuilt from the JSONL logs on startup).

### Pointing at the cloud (post-deadline)

Inference is a runtime-env swap — no rebuild. Edit `compose.env` (or set shell env)
to point `OPENAI_BASE_URL` / `UPSTREAM_BASE_URL` at the MI300X vLLM endpoint and set
`CONCURRENCY_LIMIT=0`, then `docker compose --env-file compose.env up`. See the
commented `# CLOUD` block in `docker-compose.yml`.

## Status

End-to-end and demoable: chaos engine, wire proxy (with headerless capture-all
mode), MCP shim, BYO subprocess cohorts, live dashboard + replay, two-tier
scorecard, CLI with CI gate, GitHub Action, and the containerized console stack
(`make up` → live dashboard + reference cohort with no host Python beyond
llama.cpp).
