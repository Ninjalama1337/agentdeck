#!/usr/bin/env bash
# AgentDeck — Safe Server Restart Script
# Restarts the server without killing active terminal sessions (sessions run in tmux).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\033[1m\033[32m==>\033[0m %s\n' "$*"; }

# 1. systemd user unit if active
if systemctl --user is-active agentdeck.service >/dev/null 2>&1; then
  info "Restarting AgentDeck via systemd user unit..."
  systemctl --user restart agentdeck.service
  info "Done."
  exit 0
fi

# 2. Server PID from environment or running process
PID="${AGENTDECK_SERVER_PID:-}"
if [[ -z "$PID" ]]; then
  PID="$(pgrep -f "node.*server/dist/index.js" | head -n 1 || true)"
fi

# Inherit env (port, host, dataDir) from previous running process if not set
if [[ -n "$PID" ]] && [[ -r "/proc/$PID/environ" ]]; then
  OLD_PORT="$(grep -z '^AGENTDECK_PORT=' "/proc/$PID/environ" 2>/dev/null | cut -z -d= -f2 | tr -d '\0' || true)"
  OLD_HOST="$(grep -z '^AGENTDECK_HOST=' "/proc/$PID/environ" 2>/dev/null | cut -z -d= -f2 | tr -d '\0' || true)"
  OLD_DATA="$(grep -z '^AGENTDECK_DATA_DIR=' "/proc/$PID/environ" 2>/dev/null | cut -z -d= -f2 | tr -d '\0' || true)"
  if [[ -z "${AGENTDECK_PORT:-}" ]] && [[ -n "$OLD_PORT" ]]; then export AGENTDECK_PORT="$OLD_PORT"; fi
  if [[ -z "${AGENTDECK_HOST:-}" ]] && [[ -n "$OLD_HOST" ]]; then export AGENTDECK_HOST="$OLD_HOST"; fi
  if [[ -z "${AGENTDECK_DATA_DIR:-}" ]] && [[ -n "$OLD_DATA" ]]; then export AGENTDECK_DATA_DIR="$OLD_DATA"; fi
fi

if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  info "Stopping AgentDeck server (PID $PID)..."
  kill -TERM "$PID" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
fi

info "Starting AgentDeck server..."
LOG_FILE="${AGENTDECK_LOG_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/agentdeck/server.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -f "$ROOT/server/dist/index.js" ]]; then
  setsid nohup node server/dist/index.js >> "$LOG_FILE" 2>&1 < /dev/null &
  sleep 2
  info "AgentDeck started."
else
  info "server/dist/index.js not found. Running npm run build first..."
  npm run build -w server
  setsid nohup node server/dist/index.js >> "$LOG_FILE" 2>&1 < /dev/null &
  sleep 2
  info "AgentDeck started."
fi

# Verify health
PORT="${AGENTDECK_PORT:-8787}"
HOST="${AGENTDECK_HOST:-127.0.0.1}"
if command -v curl >/dev/null 2>&1; then
  sleep 1
  curl -s "http://$HOST:$PORT/api/health" || true
  printf '\n'
fi
