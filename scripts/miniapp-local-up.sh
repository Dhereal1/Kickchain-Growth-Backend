#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/miniapp-local.log"
PID_FILE="$LOG_DIR/miniapp-local.pids"

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
    done <"$PID_FILE"
    rm -f "$PID_FILE"
  fi
}

trap cleanup EXIT INT TERM

start_bg() {
  local label="$1"
  shift

  echo "" | tee -a "$LOG_FILE" >/dev/null
  echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") START $label ===" | tee -a "$LOG_FILE" >/dev/null

  # Ensure line-buffered logs so tail is readable.
  (stdbuf -oL -eL "$@") >>"$LOG_FILE" 2>&1 &
  local pid="$!"
  echo "$pid" >>"$PID_FILE"
  echo "$label pid=$pid"
}

http_get() {
  local url="$1"
  curl -sS -m 2 "$url" 2>/dev/null || true
}

http_code() {
  local url="$1"
  local code
  code="$(curl -sS -m 1 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)"
  if [[ -z "${code:-}" ]]; then
    echo "000"
  else
    echo "$code"
  fi
}

wait_http() {
  local url="$1"
  local tries="${2:-60}"
  local sleep_s="${3:-0.5}"

  for _ in $(seq 1 "$tries"); do
    local code
    code="$(http_code "$url")"
    if [[ "$code" != "000" ]]; then
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

is_kickchain_health() {
  local port="$1"
  local body
  body="$(http_get "http://127.0.0.1:${port}/health")"
  [[ "$body" == *"kickchain-backend"* ]]
}

find_free_port() {
  local start="$1"
  local end="$2"
  for p in $(seq "$start" "$end"); do
    if [[ "$(http_code "http://127.0.0.1:${p}/health")" == "000" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

echo "Logs: $LOG_FILE"
echo "Starting backend + miniapp proxy + ngrok tunnel..."

BACKEND_PORT="${PORT:-3004}"

BACKEND_ENV=()
if [[ -z "${ENABLE_TELEGRAM_POLLING:-}" ]]; then
  BACKEND_ENV+=("ENABLE_TELEGRAM_POLLING=false")
fi
if [[ -z "${ENABLE_WORKSPACE_RUNNER_SCHEDULER:-}" ]]; then
  BACKEND_ENV+=("ENABLE_WORKSPACE_RUNNER_SCHEDULER=false")
fi

existing_health="$(http_get "http://127.0.0.1:${BACKEND_PORT}/health")"
existing_mini_code="$(http_code "http://127.0.0.1:${BACKEND_PORT}/miniapp/index.html")"
if [[ "$existing_health" == *"kickchain-backend"* ]] && [[ "$existing_mini_code" != "404" ]] && [[ "$existing_mini_code" != "000" ]]; then
  echo "Backend already running on :${BACKEND_PORT}"
else
  if [[ "$existing_health" == *"kickchain-backend"* ]]; then
    echo "Backend on :${BACKEND_PORT} is reachable but Mini App UI is missing (HTTP ${existing_mini_code}); starting a local backend on a new port..."
    BACKEND_PORT="$((BACKEND_PORT + 1))"
  fi

  free_port="$(find_free_port "$BACKEND_PORT" "$((BACKEND_PORT + 50))" || true)"
  if [[ -z "${free_port:-}" ]]; then
    echo "Could not find a free backend port in range ${BACKEND_PORT}-$((BACKEND_PORT + 50))."
    exit 1
  fi
  BACKEND_PORT="$free_port"

  start_bg "backend" env "${BACKEND_ENV[@]}" PORT="$BACKEND_PORT" npm run dev
  for _ in $(seq 1 120); do
    if is_kickchain_health "$BACKEND_PORT"; then
      break
    fi
    sleep 0.5
  done
  if ! is_kickchain_health "$BACKEND_PORT"; then
    echo "Backend did not become healthy on http://127.0.0.1:${BACKEND_PORT}/health"
    echo "Tail logs: tail -n 200 -f $LOG_FILE"
    exit 1
  fi
fi

PROXY_PORT="${MINIAPP_PROXY_PORT:-3111}"
existing_proxy_code="$(http_code "http://127.0.0.1:${PROXY_PORT}/miniapp/")"
if [[ "$existing_proxy_code" != "000" ]]; then
  echo "Miniapp proxy already running on :${PROXY_PORT}"
else
  start_bg "miniapp-proxy" env MINIAPP_PROXY_PORT="$PROXY_PORT" MINIAPP_TARGET_PORT="$BACKEND_PORT" npm run miniapp:proxy
fi
sleep 0.5

start_bg "ngrok-tunnel" npm run tunnel:miniapp

echo ""
echo "Waiting for MINIAPP_PUBLIC_URL to be written to .env..."
initial_public_url="$(rg -N "^MINIAPP_PUBLIC_URL=" "$ROOT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
for _ in $(seq 1 60); do
  next_public_url="$(rg -N "^MINIAPP_PUBLIC_URL=" "$ROOT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  if [[ -n "${next_public_url:-}" ]] && [[ "$next_public_url" != "$initial_public_url" ]]; then
    break
  fi
  sleep 0.5
done

MINIAPP_PUBLIC_URL="$(rg -N "^MINIAPP_PUBLIC_URL=" "$ROOT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
if [[ -n "${MINIAPP_PUBLIC_URL:-}" ]]; then
  MINIAPP_PUBLIC_URL="${MINIAPP_PUBLIC_URL%/}"
  echo ""
  echo "Mini App URL: ${MINIAPP_PUBLIC_URL}/miniapp"
fi

echo ""
echo "Tailing logs (Ctrl+C to stop all processes)..."
tail -n 200 -f "$LOG_FILE"
