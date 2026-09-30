#!/usr/bin/env bash
# AgentDeck-Installer: Abhängigkeiten installieren und alle Pakete bauen.
# Benötigt kein sudo. Abbrechen mit Strg+C.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- Farben (deaktivierbar via NO_COLOR=1) -----------------------------------
if [[ -n "${NO_COLOR:-}" ]] || [[ -t 1 && -n "${TERM:-}" && "${TERM}" == "dumb" ]]; then
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
else
  BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
fi

info() { printf '%s\n' "${BOLD}${GREEN}==>${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}WARN:${RESET} $*"; }
die()  { printf '%s\n' "${RED}FEHLER:${RESET} $*" >&2; exit 1; }

# --- Voraussetzungen pruefen ---------------------------------------------------
command -v node >/dev/null 2>&1 \
  || die "node nicht gefunden. Bitte Node.js >= 20 installieren: https://nodejs.org"
command -v npm >/dev/null 2>&1 \
  || die "npm nicht gefunden. Bitte Node.js >= 20 installieren (npm ist enthalten)."

NODE_MAJOR="$(node -p 'parseInt(process.versions.node, 10)')"
(( NODE_MAJOR >= 20 )) || die "Node >= 20 erforderlich, gefunden: $(node -v)."
info "Node $(node -v), npm $(npm -v) — passt."

# --- Installieren + Bauen ------------------------------------------------------
info "Installiere Abhängigkeiten (npm install, Root-Workspace) …"
npm install --no-audit --no-fund

info "Baue @agentdeck/shared …"
npm run build -w packages/shared

info "Baue server (Fastify + Adapter + MCP-Bridge) …"
npm run build -w server

info "Baue web (React-PWA) …"
npm run build -w web

# --- Abschluss-Hinweise ---------------------------------------------------------
printf '\n'
info "${BOLD}Fertig.${RESET} Server starten mit:"
printf '\n'
printf '    %snpm start%s\n' "${BOLD}" "${RESET}"
printf '\n'
printf 'Die Konsole zeigt danach den %s6-stelligen Pairing-Code%s und die\n' "${BOLD}" "${RESET}"
printf 'LAN-Adresse. Am Handy (gleiches WLAN) öffnen:\n'
printf '\n'
printf '    http://<lan-ip>:8787\n'
printf '\n'
printf 'Weitere Helfer:\n'
printf '  scripts/dev.sh            Server + Web-Dev-Server parallel (Hot Reload)\n'
printf '  scripts/build-android.sh  Android-APK bauen  (Details: docs/ANDROID.md)\n'
printf '  docs/CONFIG.md            Dauerbetrieb per systemd-User-Service\n'
