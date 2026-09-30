#!/usr/bin/env bash
# AgentDeck Dev-Modus: Server (tsx watch) und Web (Vite) parallel starten.
# Beenden mit Strg+C — beide Prozesse werden sauber heruntergefahren.
#
#   [server] Fastify  -> http://localhost:8787
#   [web]    Vite     -> http://localhost:5173 (Proxy /api + /socket.io)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PIDS=()
HAD_SETSID=0
if command -v setsid >/dev/null 2>&1; then
  HAD_SETSID=1
fi

cleanup() {
  trap - INT TERM EXIT
  printf '\n[dev] Fahre Dev-Prozesse herunter …\n'
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid:-}" ]] || continue
    if (( HAD_SETSID )); then
      # Negative PID = gesamte Prozessgruppe (npm -> tsx/vite -> Kinder).
      kill -TERM -- "-${pid}" 2>/dev/null || true
    else
      pkill -TERM -P "${pid}" 2>/dev/null || true
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# setsid macht jede Pipeline zur eigenen Prozessgruppe -> gezieltes Killen.
if (( HAD_SETSID )); then
  setsid bash -c 'exec npm run dev:server 2>&1 | sed -u "s/^/[server] /"' &
  PIDS+=("$!")
  setsid bash -c 'exec npm run dev:web 2>&1 | sed -u "s/^/[web] /"' &
  PIDS+=("$!")
else
  npm run dev:server 2>&1 | sed -u 's/^/[server] /' &
  PIDS+=("$!")
  npm run dev:web 2>&1 | sed -u 's/^/[web] /' &
  PIDS+=("$!")
fi

printf '%s\n' \
  '[dev] Server:  http://localhost:8787' \
  '[dev] Web:     http://localhost:5173 (Proxy /api + /socket.io -> :8787)' \
  '[dev] Beenden: Strg+C'

wait
