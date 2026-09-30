#!/usr/bin/env bash
# AgentDeck: Android-Debug-APK bauen (Capacitor 7).
# Prueft SDK und generiertes Android-Projekt mit klaren Meldungen.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "${NO_COLOR:-}" ]]; then
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
else
  BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
fi
info() { printf '%s\n' "${BOLD}${GREEN}==>${RESET} $*"; }
die()  { printf '%s\n' "${RED}FEHLER:${RESET} $*" >&2; exit 1; }

# --- 1) Abhaengigkeiten ---------------------------------------------------------
if [[ ! -d node_modules ]]; then
  die "node_modules fehlt. Erst 'npm install' (oder scripts/install.sh) ausführen."
fi

# --- 2) Android SDK suchen --------------------------------------------------------
SDK_CANDIDATES=(
  "${ANDROID_SDK_ROOT:-}"
  "${ANDROID_HOME:-}"
  "$HOME/Android/Sdk"
  "$HOME/Library/Android/sdk"
  "/opt/android-sdk"
  "/usr/local/lib/android/sdk"
)
SDK_DIR=""
for candidate in "${SDK_CANDIDATES[@]}"; do
  if [[ -n "$candidate" && -d "$candidate" ]]; then
    SDK_DIR="$candidate"
    break
  fi
done

if [[ -z "$SDK_DIR" ]]; then
  die "Kein Android SDK gefunden.
  Setze ANDROID_SDK_ROOT oder installiere die cmdline-tools
  (https://developer.android.com/studio#command-line-tools-only).
  Details: docs/ANDROID.md  (oder nutze den GitHub-Actions-Bau ohne lokales SDK)."
fi
export ANDROID_SDK_ROOT="$SDK_DIR"
info "Android SDK: $SDK_DIR"

# --- 3) Java grob pruefen (Capacitor 7 will JDK 21) ------------------------------
# Bekannte JDK-21-Orte bevorzugen, falls JAVA_HOME nicht gesetzt ist.
if [[ -z "${JAVA_HOME:-}" ]]; then
  for cand in "$HOME/.local/opt/jdk-21" "$HOME/.jdks/jdk-21" /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/temurin-21-jdk; do
    if [[ -x "$cand/bin/java" ]]; then export JAVA_HOME="$cand" PATH="$cand/bin:$PATH"; break; fi
  done
fi
if ! command -v java >/dev/null 2>&1; then
  die "java nicht gefunden. JDK 21 installieren (z. B. Temurin: https://adoptium.net)."
fi
JAVA_MAJOR="$(java -version 2>&1 | head -n 1 | sed -E 's/.*version "([0-9]+).*/\1/')"
if (( JAVA_MAJOR < 21 )); then
  printf '%s\n' "${YELLOW}WARN:${RESET} java ${JAVA_MAJOR} gefunden — Capacitor 7 erwartet JDK 21."
fi

# --- 4) Web bauen und nach mobile/dist kopieren ---------------------------------
# mobile/dist muss existieren, BEVOR `cap add android` laeuft (webDir-Pruefung).
info "Baue Web-App (npm run build:web / copy:web -w mobile) …"
npm run build:web -w mobile
npm run copy:web -w mobile

# --- 5) Android-Projekt (einmalig generieren), Rechte, Sync -----------------------
if [[ ! -d mobile/android ]]; then
  info "mobile/android fehlt — generiere Plattform (einmalig) …"
  ( cd mobile && npx cap add android )
fi
# Mikrofon (Diktat), Benachrichtigungen, Vibration — idempotent.
( cd mobile && npm run patch:android )
( cd mobile && npx cap sync android )

# --- 6) APK bauen -------------------------------------------------------------------
info "Baue Debug-APK (gradlew assembleDebug) …"
(
  cd mobile/android
  chmod +x gradlew
  ./gradlew assembleDebug
)

APK="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  die "APK wurde nicht gefunden: $APK (Gradle-Log oben prüfen)."
fi

printf '\n'
info "${BOLD}Fertig.${RESET} APK:"
printf '    %s\n' "$APK"
printf '\nInstallieren:  adb install -r %s\n' "$APK"
