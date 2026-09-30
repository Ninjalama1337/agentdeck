#!/usr/bin/env bash
# AgentDeck: APK an den laufenden AgentDeck-Server hochladen.
#
# Die APK liegt danach unter /api/apk/latest, erscheint auf der Pairing-Seite
# und in den Settings — gepaarte Geraete zeigen beim naechsten Start den
# Update-Banner. Auth läuft über den Bridge-Token des Servers (nur localhost).
# Fuer den automatisierten Weg siehe .github/workflows/android.yml (CI-Secrets)
# und docs/REMOTE.md.
set -euo pipefail

if [[ -n "${NO_COLOR:-}" ]]; then
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
else
  BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
fi
info() { printf '%s\n' "${BOLD}${GREEN}==>${RESET} $*"; }
die()  { printf '%s\n' "${RED}FEHLER:${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
AgentDeck — APK an den Server hochladen (POST /api/apk/upload)

Aufruf:
  scripts/upload-apk.sh <apk-pfad> [version]

Argumente:
  <apk-pfad>  Pfad zur APK-Datei, z. B.
              mobile/android/app/build/outputs/apk/debug/app-debug.apk
  [version]   Versions-String, z. B. "1.2.3" oder "0.1.42".
              Ohne Angabe wird die Version aus dem Dateinamen gelesen
              (Muster: agentdeck-<version>.apk).

Umgebungsvariablen:
  AGENTDECK_URL           Basis-URL des Servers (Default: http://127.0.0.1:8787)
  AGENTDECK_DATA_DIR      Server-Datenverzeichnis (Default: ~/.local/share/agentdeck)
  AGENTDECK_BRIDGE_TOKEN  Bridge-Token. Default: Inhalt aus
                          <dataDir>/bridge-token — funktioniert also, wenn das
                          Skript auf dem Server-Rechner laeuft; fuer entfernte
                          Server das Token explizit setzen.
  AGENTDECK_APK_CHANNEL   Channel-Kennung (Default: "manual"; die CI nutzt
                          "ci" bzw. "release").

Beispiele:
  scripts/upload-apk.sh app-debug.apk 0.1.42
  AGENTDECK_URL=https://agentdeck.example.com AGENTDECK_BRIDGE_TOKEN=... \
    scripts/upload-apk.sh agentdeck-1.2.3.apk
EOF
}

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  [[ $# -ge 1 ]] && exit 0
  exit 1
fi

APK_PATH="${1:?}"
VERSION="${2:-}"
URL="${AGENTDECK_URL:-http://127.0.0.1:8787}"
DATA_DIR="${AGENTDECK_DATA_DIR:-$HOME/.local/share/agentdeck}"
CHANNEL="${AGENTDECK_APK_CHANNEL:-manual}"
URL="${URL%/}"

command -v curl >/dev/null 2>&1 || die "curl wird benoetigt (Paketmanager deiner Wahl)."
[[ -f "$APK_PATH" ]] || die "APK nicht gefunden: $APK_PATH"

# --- Version: Argument gewinnt, sonst aus dem Dateinamen ableiten ------------
if [[ -z "$VERSION" ]]; then
  BASENAME="$(basename "$APK_PATH")"
  if [[ "$BASENAME" =~ ^[Aa]gent[Dd]eck-([0-9][0-9A-Za-z._-]*)\.apk$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  fi
fi
[[ -n "$VERSION" ]] || die "Keine Version angegeben und aus dem Dateinamen nicht ableitbar (Muster: agentdeck-<version>.apk). Es wurde: $(basename "$APK_PATH")"

# --- Bridge-Token: Env gewinnt, sonst Datei im Datenverzeichnis --------------
TOKEN="${AGENTDECK_BRIDGE_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN_FILE="$DATA_DIR/bridge-token"
  if [[ ! -f "$TOKEN_FILE" ]]; then
    die "Kein Bridge-Token gefunden.
  Entweder AGENTDECK_BRIDGE_TOKEN setzen oder das Skript auf dem
  Server-Rechner ausfuehren, wo $TOKEN_FILE liegt."
  fi
  TOKEN="$(cat "$TOKEN_FILE")"
fi

# --- Upload -------------------------------------------------------------------
info "Lade $(basename "$APK_PATH") hoch (Version $VERSION, Channel $CHANNEL) an $URL"
BODY_FILE="$(mktemp)"
HTTP_CODE="$(curl -sS --max-time 300 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$URL/api/apk/upload" \
  -H "x-bridge-token: $TOKEN" \
  -F "apk=@${APK_PATH}" \
  -F "version=${VERSION}" \
  -F "channel=${CHANNEL}")" || { rm -f "$BODY_FILE"; die "Netzwerkfehler — laeuft der Server unter $URL?"; }

if [[ "$HTTP_CODE" != 2* ]]; then
  printf '%s\n' "--- Antwort des Servers ---" >&2
  cat "$BODY_FILE" >&2 || true
  rm -f "$BODY_FILE"
  die "Upload fehlgeschlagen (HTTP $HTTP_CODE). Stimmt AGENTDECK_BRIDGE_TOKEN? Ist die APK kleiner als maxApkBytes?"
fi
rm -f "$BODY_FILE"
info "${BOLD}Upload OK.${RESET}"

# --- Resultierenden Stand anzeigen -------------------------------------------
INFO="$(curl -sf --max-time 30 "$URL/api/apk/info")" \
  || die "Upload erfolgreich, aber /api/apk/info nicht abrufbar."
printf '%s\n' "$INFO"
printf '\nDie APK steht jetzt bereit:\n  %s/api/apk/latest\n' "$URL"
