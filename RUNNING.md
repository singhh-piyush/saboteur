# RUNNING.md — Saboteur local guide

Run Saboteur end-to-end on a fresh checkout, top to bottom, with **zero
improvisation**. Every command is copy-pasteable from the repo root.

Saboteur is chaos engineering for AI agents: it sabotages an agent's tool calls,
context, and transport, then scores whether the agent self-heals. Everything —
the orchestrator API, the wire-level chaos proxy, the MCP shim's dashboard side,
and the React console — runs in **one process on one port (`:8000`)**.

> **Inference modes.** Two ways to drive agents:
> - **Real local LLM** — llama.cpp `llama-server` with a Llama-3.1-8B GGUF (§2a).
> - **Offline mock** — a bundled deterministic mock model, no GPU/secrets
>   (§2b). Use this for CI, demos, and any "is it wired up?" check. Every step
>   below that needs inference shows the `--mock` variant.

---

## 1. Prerequisites

- **Python 3.11+** (`python3 --version`)
- **Node 20+** and npm (`node --version`) — only to build the dashboard
- **Docker + Compose** (optional, for §9)
- A chat-tool-capable GGUF for the real-LLM path. One-line download:

  ```bash
  # needs: pip install huggingface_hub
  huggingface-cli download bartowski/Meta-Llama-3.1-8B-Instruct-GGUF \
    Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
    --local-dir ./models
  ```

---

## 2. Inference backend

### 2a. Real local LLM (llama.cpp)

`--jinja` is **required** — without it llama-server won't emit OpenAI tool calls,
and Saboteur sabotages the JSON tool-call boundary, so the agent can't run.

```bash
llama-server \
  -m ./models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  -c 32768 -np 8 \
  --jinja
```

- `-np 8` = 8 parallel slots (local cohort cap is **N=8**; the `-c` context is
  split across slots). `--host 0.0.0.0` is needed if the dashboard runs in Docker.
- Smoke it: `curl -fsS http://localhost:8080/health`.

### 2b. Offline mock (no GPU, no secrets)

Nothing to start by hand — `saboteur run --mock` boots the bundled
`saboteur.mock_inference` server, points inference at it, runs, and tears it
down. Deterministic, so cohorts are reproducible.

---

## 3. Install

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"          # app + ruff/mypy/types

cd frontend && npm ci && cd ..   # dashboard deps
```

`.env` is optional for local dev (defaults target `http://localhost:8080/v1`).
Copy `.env.example` to `.env` only to change the model/endpoint — the swap is
pure config, never a code edit.

---

## 4. Start the app

```bash
bash scripts/run_local.sh        # starts llama-server if down, then uvicorn --reload
# or, app only (LLM already up):
.venv/bin/uvicorn saboteur.api:app --reload --port 8000
# or the all-in-one dev loop (llama-server + uvicorn + vite):
make dev
```

Open **http://localhost:8000**. Surfaces on the same port:

| Path | What |
|---|---|
| `/` | React console (served from `frontend/dist` when built) |
| `/health`, `/proxy/health`, `/mcp/health` | liveness |
| `/v1/chat/completions`, `/v1/models` | **the wire chaos proxy** (OpenAI-compatible) |
| `/runs`, `/ws/{run_id}`, `/profiles`, `/targets`, `/faults` | orchestrator API |

> The proxy is mounted at **`/v1`** (not `/proxy/v1`) so a BYO agent only needs
> `OPENAI_BASE_URL=http://localhost:8000/v1` — the standard OpenAI base. `/proxy/*`
> holds the run-management routes. No route collides with `/runs`/`/ws`/`/profiles`.

---

## 5. Reference cohort (Saboteur's own smolagents agent)

```bash
# Script (preflights llama.cpp, runs control + chaos, prints the scorecard):
.venv/bin/python scripts/run_cohort.py

# CLI (in-process, serverless). --control adds the calm_seas baseline:
.venv/bin/saboteur run --target reference --profile hell_mode --control

# Offline, no GPU (deterministic mock):
.venv/bin/saboteur run --target reference --profile hell_mode --control --mock
```

Artifacts land in `runs/{run_id}.jsonl` + `runs/{run_id}.scorecard.json` (+ a
`-control` pair). Profiles: `saboteur profiles` (calm_seas, flaky_friday,
rate_limit_storm, liars_den, hell_mode).

---

## 6. BYO cohort ("Battle Royale for your agent")

Sabotage an agent you **don't** own: N subprocess copies pointed at the wire
proxy, rendered live on the same grid.

```bash
# 1. Register the bundled ~40-line raw-OpenAI-SDK example agent as a target.
#    Its regex oracle (ANSWER: 71.6) lets survival/deception light up.
curl -fsS -X POST localhost:8000/targets -H 'Content-Type: application/json' -d '{
  "name": "min_agent",
  "kind": "command",
  "cmd": ["python", "examples/byo_min_agent/agent.py"],
  "oracle": {"kind": "regex", "pattern": "ANSWER:\\s*71\\.6"}
}'

# 2. Launch a cohort through the proxy (chaos-only; no control in BYO v1):
.venv/bin/saboteur run --target min_agent --profile flaky_friday
#    …or from the UI: pick the target + profile and Launch.
```

Watch the grid at `:8000`. Each subprocess gets a card; faults are injected on
its `/v1/chat/completions` traffic (it forwards `X-Saboteur-*` headers — see
`examples/byo_min_agent/`). A target with **no** oracle renders neutral grey
**"done"** cells and a **"—"** survival ticker (we never fabricate a verdict).

---

## 7. CI gate (exit codes for a shell `if`)

`saboteur run --ci` is **direction-aware**: a higher-is-better metric
(`survival_rate`) fails *below* `--threshold` (a floor); a lower-is-better metric
(`crash_rate`, `mttr_steps`, `waste_factor`) fails *above* it (a ceiling). Exit
`0` pass, `1` breach, `2` ungateable. Gate behavioral metrics for no-oracle targets.

```bash
# PASS (exit 0): crash_rate must stay UNDER the 0.5 ceiling (hell_mode ~0%), offline.
if .venv/bin/saboteur run --target reference --profile hell_mode --mock \
     --ci --metric crash_rate --threshold 0.5; then
  echo "resilience OK"
fi

# FAIL (exit 1): demand 95% survival under hell_mode — the agent can't.
.venv/bin/saboteur run --target reference --profile hell_mode --mock \
  --ci --metric survival_rate --threshold 0.95
echo "exit=$?"   # → 1

# Guard rails (exit 2, before any cohort runs):
#   survival_rate on a no-oracle target → 2 (pick a behavioral metric)
#   waste_factor without --control       → 2
#   latency_degradation as a gate metric → 2 (contention-contaminated)
```

---

## 8. Replay a golden JSONL (offline demo insurance)

Re-drive the dashboard from a recorded run — **all inference offline**.

```bash
# App must be up (§4). A captured golden hell_mode run ships in runs/:
.venv/bin/saboteur replay runs/hell_mode-20260629T231833-2b225c.jsonl --speed 2.0 --follow
# → POSTs /replay, prints a new replay-* run_id; open it on the dashboard.
```

Replay is a pure re-emit of the JSONL (no LLM), so the grid + scorecard render
identically to the live run (invariant #3).

---

## 9. Docker (the console stack)

One container serves the API + proxy + built frontend. `runs/` is bind-mounted
so artifacts + the SQLite index survive `down`/`up`.

```bash
# Host llama-server must be running with --host 0.0.0.0 (§2a), reachable as
# host.docker.internal (configured in docker-compose.yml).
make up                         # build + start + wait for /health
open http://localhost:8000
PROFILE=hell_mode make run      # POST a reference cohort to the running console
make logs                       # follow
make down                       # stop (runs/ persists)
```

Inference swap (post-deadline → MI300X vLLM): edit `compose.env`
(`OPENAI_BASE_URL` / `UPSTREAM_BASE_URL` / `MODEL_ID`), `make up`. No rebuild,
no code change.

---

## 10. Tests, types, lint

```bash
make test                       # pytest -q (backend)
make lint                       # ruff check . && mypy saboteur
cd frontend && npm run build && npx vitest run && cd ..   # tsc + reducer tests
```

Expected: backend green, frontend `tsc` clean + reducer tests green, ruff +
mypy clean.

---

## 11. One-line health smoke

```bash
curl -fsS localhost:8000/health && curl -fsS localhost:8000/proxy/health \
  && curl -fsS localhost:8000/mcp/health && echo \
  && .venv/bin/saboteur run --target reference --profile calm_seas --n 2 --mock
```

If the scorecard prints with `survival_rate 100%`, the whole stack — API,
scoring, telemetry, mock inference — is healthy end-to-end.
