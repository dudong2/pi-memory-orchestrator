#!/bin/sh
set -eu

MODEL=${1:?usage: start-sidecar.sh <openrouter-model>}
PORT=${SIDECAR_PORT:-18911}
RUNTIME=${HOME}/.hindsight/hindsight-runtime/openrouter-sidecar
PID_FILE=${RUNTIME}/pid
SAFE_MODEL=$(printf '%s' "$MODEL" | tr '/:' '__')
mkdir -p "$RUNTIME"
chmod 700 "$RUNTIME"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    COMMAND=$(ps -p "$OLD_PID" -o command= 2>/dev/null || true)
    case "$COMMAND" in
      *hindsight-api*"--port $PORT"*) kill "$OLD_PID"; wait "$OLD_PID" 2>/dev/null || true ;;
      *) echo "refusing to stop unexpected pid $OLD_PID" >&2; exit 1 ;;
    esac
  fi
fi

OUT=${RUNTIME}/${SAFE_MODEL}.stdout.log
ERR=${RUNTIME}/${SAFE_MODEL}.stderr.log
: > "$OUT"
: > "$ERR"
chmod 600 "$OUT" "$ERR"
nohup /bin/sh -c '
  set -a
  . "$1"
  set +a
  export HINDSIGHT_API_WORKER_ENABLED=false
  export HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP=false
  export HINDSIGHT_API_MCP_ENABLED=false
  export HINDSIGHT_API_RERANKER_PROVIDER=openrouter
  if [ -n "$5" ]; then export HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY="$5"; fi
  export HINDSIGHT_API_RERANKER_OPENROUTER_MODEL="$2"
  export HINDSIGHT_API_RERANKER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/rerank
  export HINDSIGHT_API_RERANKER_OPENROUTER_TIMEOUT=30
  export HINDSIGHT_API_RERANKER_MAX_CANDIDATES=300
  export HINDSIGHT_API_RERANKER_1_PROVIDER=rrf
  export HINDSIGHT_API_RERANKER_MAX_RETRIES=1
  export HINDSIGHT_API_RERANKER_RETRY_BUDGET=3
  exec "$3" --host 127.0.0.1 --port "$4"
' sidecar \
  "$HOME/.hindsight/hindsight-control/server.env" \
  "$MODEL" \
  "$HOME/.hindsight/hindsight-deps/venv/bin/hindsight-api" \
  "$PORT" \
  "${SIDECAR_OPENROUTER_API_KEY_OVERRIDE:-}" >"$OUT" 2>"$ERR" &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"
chmod 600 "$PID_FILE"
printf 'pid=%s model=%s port=%s\n' "$PID" "$MODEL" "$PORT"
