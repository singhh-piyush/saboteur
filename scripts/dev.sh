#!/usr/bin/env bash
# dev.sh — one-command dev environment: llama-server + uvicorn + vite
#
# Starts each service in dependency order, health-gates before the next,
# interleaves their logs with colored prefixes, and tears everything down
# cleanly on Ctrl+C — never killing a llama-server it did not start.
#
# Usage: ./scripts/dev.sh [--no-llm] [--no-web] [--quiet-llm]
#   --no-llm      skip llama-server (assume :8080 already running)
#   --no-web      skip vite (backend-only, useful for curl-driven testing)
#   --quiet-llm   suppress [LLM] lines except errors/warnings

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# Load .env so MODEL_GGUF and other vars are available.
if [[ -f .env ]]; then
    set -a
    # shellcheck source=/dev/null
    source .env
    set +a
fi

# --- colors ---
C_LLM=$'\033[36m'   # cyan
C_API=$'\033[32m'   # green
C_WEB=$'\033[35m'   # magenta
C_ERR=$'\033[31m'   # red
NC=$'\033[0m'

LLM_PFX="${C_LLM}[LLM] ${NC}"
API_PFX="${C_API}[API] ${NC}"
WEB_PFX="${C_WEB}[WEB] ${NC}"

# --- flags ---
NO_LLM=0 NO_WEB=0 QUIET_LLM=0
for arg in "$@"; do
    case $arg in
        --no-llm)    NO_LLM=1 ;;
        --no-web)    NO_WEB=1 ;;
        --quiet-llm) QUIET_LLM=1 ;;
        -h|--help)   printf 'Usage: %s [--no-llm] [--no-web] [--quiet-llm]\n' "$(basename "$0")"; exit 0 ;;
        *)           printf '%s[dev] unknown flag: %s%s\n' "$C_ERR" "$arg" "$NC" >&2; exit 2 ;;
    esac
done

PIDS=()
LLAMA_STARTED=0
MODEL_LABEL="(external)"

# --- helper: prefix each line of stdin with a colored label ---
prefix_stream() {
    local p=$1 line
    while IFS= read -r line; do
        printf '%s%s\n' "$p" "$line"
    done
}

# launch PREFIX CMD [ARGS...] — start CMD in background, prefix its output.
# $! is the real service PID (process substitution coprocess gets EOF on exit).
launch() {
    local prefix=$1; shift
    "$@" > >(prefix_stream "$prefix") 2>&1 &
    PIDS+=("$!")
}

# wait_http URL [CAP_SECS=30] — poll until URL returns 200 or cap expires.
wait_http() {
    local url=$1 cap=${2:-30}
    while (( cap-- > 0 )); do
        curl -sf "$url" >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# wait_port PORT [CAP_SECS=30] — poll until localhost:PORT returns any HTTP response.
# curl handles IPv4/IPv6 automatically (vite binds [::1] on some systems).
wait_port() {
    local port=$1 cap=${2:-30}
    while (( cap-- > 0 )); do
        curl -so /dev/null "http://localhost:$port" 2>/dev/null && return 0
        sleep 1
    done
    return 1
}

# kill_tree PID — send SIGTERM to PID and all its descendants.
kill_tree() {
    local pid=$1 child
    for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
    kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
    trap - INT TERM EXIT
    set +eu
    # Kill only the processes this script started.
    for pid in "${PIDS[@]}"; do
        [[ -n $pid ]] && kill_tree "$pid"
    done
    sleep 1
    # SIGKILL any survivors.
    for pid in "${PIDS[@]}"; do
        [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    done
    # If we started llama-server and it is still alive, force-kill it.
    # This block is gated on LLAMA_STARTED so a reused/external server is
    # never touched even if it happens to be visible in the process table.
    if (( LLAMA_STARTED )) && pgrep -f 'llama-server' >/dev/null 2>&1; then
        printf '%s[dev] llama-server survived — SIGKILL%s\n' "$C_ERR" "$NC" >&2
        pkill -KILL -f 'llama-server' 2>/dev/null || true
    fi
    wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Prefer the venv uvicorn if available.
UVICORN=uvicorn
[[ -x .venv/bin/uvicorn ]] && UVICORN=.venv/bin/uvicorn

# ─── 1. LLM ──────────────────────────────────────────────────────────────────

if (( NO_LLM )); then
    printf '%s--no-llm: assuming server on :8080\n' "$LLM_PFX"
    MODEL_LABEL="--no-llm (assumed external)"

elif curl -sf "http://localhost:8080/health" >/dev/null 2>&1; then
    printf '%sreusing existing server\n' "$LLM_PFX"
    # LLAMA_STARTED stays 0 → cleanup will not pkill this server.
    MODEL_LABEL="reused (external)"

else
    : "${MODEL_GGUF:?MODEL_GGUF is not set. Add MODEL_GGUF=/path/to/model.gguf to .env or export it.}"
    if [[ ! -f $MODEL_GGUF ]]; then
        printf '%s[dev] MODEL_GGUF file not found: %s%s\n' "$C_ERR" "$MODEL_GGUF" "$NC" >&2
        exit 1
    fi
    MODEL_LABEL="$MODEL_GGUF"
    printf '%sstarting llama-server ...\n' "$LLM_PFX"

    if (( QUIET_LLM )); then
        # Under --quiet-llm, only surface error/warning lines.
        llama-server -m "$MODEL_GGUF" --port 8080 -c 32768 -np 8 --jinja \
            > >(grep --line-buffered -iE 'error|fail|fatal|warn' \
                | prefix_stream "$LLM_PFX") 2>&1 &
    else
        llama-server -m "$MODEL_GGUF" --port 8080 -c 32768 -np 8 --jinja \
            > >(prefix_stream "$LLM_PFX") 2>&1 &
    fi
    PIDS+=("$!")
    LLAMA_STARTED=1

    if ! wait_http "http://localhost:8080/health" 60; then
        printf '%s[dev] llama-server did not become ready in 60 s%s\n' "$C_ERR" "$NC" >&2
        exit 1
    fi
    printf '%shealthy\n' "$LLM_PFX"
fi

# ─── 2. API ──────────────────────────────────────────────────────────────────

printf '%sstarting uvicorn ...\n' "$API_PFX"
launch "$API_PFX" "$UVICORN" saboteur.api:app --reload --host 0.0.0.0 --port 8000
if ! wait_http "http://localhost:8000/health" 30; then
    printf '%s[dev] API did not become ready in 30 s%s\n' "$C_ERR" "$NC" >&2
    exit 1
fi
printf '%shealthy\n' "$API_PFX"

# ─── 3. WEB ──────────────────────────────────────────────────────────────────

if (( ! NO_WEB )); then
    printf '%sstarting vite ...\n' "$WEB_PFX"
    launch "$WEB_PFX" npm --prefix frontend run dev
    if ! wait_port 5173 30; then
        printf '%s[dev] Vite did not start in 30 s%s\n' "$C_ERR" "$NC" >&2
        exit 1
    fi
    printf '%shealthy\n' "$WEB_PFX"
fi

# ─── Banner ───────────────────────────────────────────────────────────────────

printf '\n  ┌─ saboteur dev ─────────────────────\n'
(( ! NO_WEB )) && printf '  │ Dashboard  : http://localhost:5173\n'
printf '  │ API docs   : http://localhost:8000/docs\n'
printf '  │ Model      : %s\n' "$MODEL_LABEL"
printf '  └────────────────────────────────────\n\n'
printf '[dev] Ctrl+C to stop all services\n'

wait
