#!/usr/bin/env bash
# AgentDeck: diesen Checkout auf ein GitHub-Release bringen und den Server
# neu starten. Wird vom Server gestartet (App: Settings → Server update),
# laeuft aber genauso von Hand:
#
#   scripts/update.sh            neuestes Release
#   scripts/update.sh v1.2.3     ein bestimmtes Release
#
# Ablauf: Checkout per Fast-Forward auf das Tag, bei geaendertem Lockfile
# `npm ci`, `npm run build`, Release-APK beim laufenden Server hinterlegen,
# Server neu starten (scripts/restart.sh). Schlaegt der Build fehl, geht der
# Checkout auf den alten Stand zurueck — der laufende Server bleibt unberuehrt.
#
# Umgebungsvariablen (der Server setzt sie selbst):
#   AGENTDECK_URL         lokale Adresse des Servers (Default: http://127.0.0.1:8787)
#   AGENTDECK_DATA_DIR    Datenverzeichnis (fuer den Bridge-Token des APK-Uploads)
#   AGENTDECK_SERVER_PID  welcher Prozess neu gestartet wird
#   AGENTDECK_UPDATE_LOG  Logdatei fuer den Neustart am Ende
set -euo pipefail

# Alles in main(): bash liest ein Skript stueckweise, und der Fast-Forward kann
# genau diese Datei ersetzen. So ist sie vollstaendig geparst, bevor etwas laeuft.
main() {
  local ROOT TAG OLD CHANGED=0
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$ROOT"
  TAG="${1:-}"

  info() { printf '==> %s\n' "$*"; }
  warn() { printf 'WARN: %s\n' "$*"; }
  die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

  for tool in git npm gh; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool nicht gefunden."
  done
  [[ -d .git ]] || die "Kein git-Checkout: $ROOT"

  local DIRTY
  DIRTY="$(git status --porcelain --untracked-files=no)"
  if [[ -n "$DIRTY" ]]; then
    printf '%s\n' "$DIRTY" >&2
    die "Der Checkout hat uncommittete Aenderungen — erst committen oder verwerfen."
  fi

  if [[ -z "$TAG" ]]; then
    TAG="$(gh release view --json tagName -q .tagName 2>/dev/null)" \
      || die "Kein Release gefunden (oder gh nicht angemeldet: gh auth login)."
  fi
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Unerwartetes Release-Tag: $TAG"

  info "Hole $TAG von origin …"
  git fetch --quiet --tags origin || die "git fetch fehlgeschlagen."
  git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || die "Tag $TAG gibt es auf origin nicht."

  OLD="$(git rev-parse HEAD)"
  if git merge-base --is-ancestor "$TAG" HEAD; then
    info "Der Checkout enthaelt $TAG bereits ($(git describe --tags --match 'v[0-9]*' 2>/dev/null || echo "$OLD"))."
  else
    git merge-base --is-ancestor HEAD "$TAG" \
      || die "Der Checkout hat Commits, die nicht in $TAG stecken — kein Fast-Forward moeglich."
    git merge --ff-only --quiet "$TAG" || die "Fast-Forward auf $TAG fehlgeschlagen."
    CHANGED=1
    info "Checkout steht auf $TAG."
  fi

  # $1 = Stand, gegen den das Lockfile verglichen wird.
  install_and_build() {
    if [[ ! -d node_modules ]] || ! git diff --quiet "$1" HEAD -- package-lock.json; then
      info "Abhaengigkeiten geaendert — npm ci …"
      npm ci --no-audit --no-fund || return 1
    fi
    info "Baue (npm run build) …"
    npm run build || return 1
  }

  if (( CHANGED )); then
    if ! install_and_build "$OLD"; then
      warn "Build fehlgeschlagen — gehe zurueck auf den alten Stand."
      git reset --hard --quiet "$OLD"
      install_and_build "$TAG" || warn "Auch der alte Stand baut nicht mehr — bitte von Hand pruefen."
      die "Update auf $TAG abgebrochen; der laufende Server ist unveraendert."
    fi
  fi

  # Release-APK beim (noch laufenden) Server hinterlegen: gepaarte Handys sehen
  # danach das Update-Banner. Fehlt die APK am Release, geht es ohne weiter.
  local URL VERSION HOSTED TMP
  URL="${AGENTDECK_URL:-http://127.0.0.1:8787}"
  VERSION="${TAG#v}"
  HOSTED="$(curl -sf --max-time 10 "$URL/api/apk/info" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  if [[ "$HOSTED" == "$VERSION" ]]; then
    info "APK $VERSION liegt schon auf dem Server."
  else
    TMP="$(mktemp -d)"
    if gh release download "$TAG" --pattern 'app-debug.apk' --dir "$TMP" 2>/dev/null; then
      if AGENTDECK_URL="$URL" AGENTDECK_APK_CHANNEL=release NO_COLOR=1 \
          "$ROOT/scripts/upload-apk.sh" "$TMP/app-debug.apk" "$VERSION" >/dev/null; then
        info "APK $VERSION beim Server hinterlegt."
      else
        warn "APK konnte nicht hochgeladen werden (laeuft der Server unter $URL?)."
      fi
    else
      warn "Release $TAG hat keine APK (app-debug.apk) — ueberspringe."
    fi
    rm -rf "$TMP"
  fi

  if (( CHANGED )); then
    info "Starte den Server neu — die App verbindet sich gleich wieder."
    # Losgeloest: der Neustart beendet den Prozess, der dieses Skript gestartet hat.
    setsid nohup "$ROOT/scripts/restart.sh" >> "${AGENTDECK_UPDATE_LOG:-/dev/null}" 2>&1 < /dev/null &
  else
    info "Nichts zu tun — kein Neustart."
  fi
}

main "$@"
exit $?
