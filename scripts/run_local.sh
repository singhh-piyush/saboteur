#!/usr/bin/env bash
# Usage: ./scripts/run_local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env so MODEL_GGUF (and other vars) are available.
if [[ -f "$REPO_ROOT/.env" ]]; then
    # Export only non-comment, non-empty lines.
    set -a
    # shellcheck source=/dev/null
    source "$REPO_ROOT/.env"
    set +a
fi

: "${MODEL_GGUF:?MODEL_GGUF is not set. Add it to .env or export it before running this script.}"

# Ports (env or .env overridable — e.g. when an SSH tunnel owns :8000).
API_PORT="${API_PORT:-8000}"
LLM_PORT="${LLM_PORT:-8080}"
LLAMA_HEALTH="http://localhost:$LLM_PORT/health"

start_llama_server() {
    echo "[run_local] Starting llama-server..."
    llama-server \
        -m "$MODEL_GGUF" \
        --port "$LLM_PORT" \
        -c 32768 \
        -np 8 \
        --jinja \
        >> "$REPO_ROOT/llama-server.log" 2>&1 &
    LLAMA_PID=$!
    echo "[run_local] llama-server PID=$LLAMA_PID (log: llama-server.log)"
}

wait_for_llama() {
    echo "[run_local] Waiting for llama-server to be ready..."
    local retries=60
    while (( retries-- > 0 )); do
        if curl -sf "$LLAMA_HEALTH" > /dev/null 2>&1; then
            echo "[run_local] llama-server is ready."
            return 0
        fi
        sleep 1
    done
    echo "[run_local] ERROR: llama-server did not become ready in 60s. Check llama-server.log." >&2
    exit 1
}

# Only start llama-server if it is not already responding.
if curl -sf "$LLAMA_HEALTH" > /dev/null 2>&1; then
    echo "[run_local] llama-server already running — skipping launch."
else
    start_llama_server
    wait_for_llama
fi

echo "[run_local] Starting uvicorn (reload mode)..."
cd "$REPO_ROOT"
exec uvicorn saboteur.api:app --reload --host 0.0.0.0 --port "$API_PORT"
