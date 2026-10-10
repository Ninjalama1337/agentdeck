#!/bin/sh
# Launcher of the AppImage (put in place of the Electron binary by build/after-pack-appimage.cjs).
#
# Why: electron-builder's generated AppRun adds --no-sandbox on its own when user namespaces are
# unavailable. AgentDeck does not turn the Chromium sandbox off silently. Without a working
# sandbox it stops with an explanation; --no-sandbox only comes from AGENTDECK_NO_SANDBOX=1.
#
# Ubuntu 24.04+ restricts user namespaces for programs without an AppArmor profile — the .deb
# installs one; an AppImage cannot, so it needs the profile below (or the .deb).
HERE="$(dirname "$(readlink -f "$0")")"
BIN="$HERE/agentdeck.bin"

# Drop every --no-sandbox that came with the arguments (AppRun's, or typed by hand).
n=$#
while [ "$n" -gt 0 ]; do
  arg="$1"
  shift
  n=$((n - 1))
  [ "$arg" = "--no-sandbox" ] || set -- "$@" "$arg"
done

if [ "${AGENTDECK_NO_SANDBOX:-}" = "1" ]; then
  echo "AgentDeck: starting WITHOUT the Chromium sandbox (AGENTDECK_NO_SANDBOX=1)." >&2
  exec "$BIN" --no-sandbox "$@"
fi

# Chromium sets up its sandbox from a user namespace; try the same here. (As root Chromium refuses
# to run on its own, with its own message — nothing to probe.)
PROBE="${AGENTDECK_SANDBOX_PROBE:-unshare -Ur true}"
if [ "$(id -u)" = "0" ] || $PROBE >/dev/null 2>&1; then
  exec "$BIN" "$@"
fi

IMAGE="${APPIMAGE:-/path/to/AgentDeck.AppImage}"
MESSAGE="AgentDeck kann auf diesem System die Chromium-Sandbox nicht starten.

Ubuntu 24.04 und neuer sperren Benutzer-Namensräume für Programme ohne AppArmor-Profil.
Das AppImage kann kein Profil mitbringen. Lösungen:

1. Das .deb-Paket installieren — es richtet das Profil ein (empfohlen).

2. Ein Profil für dieses AppImage anlegen (einmalig, als root):
     sudo tee /etc/apparmor.d/agentdeck-appimage >/dev/null <<'PROFILE'
     abi <abi/4.0>,
     include <tunables/global>
     profile agentdeck-appimage \"$IMAGE\" flags=(unconfined) {
       userns,
     }
     PROFILE
     sudo systemctl reload apparmor

3. Notlösung, ohne Sandbox (unsicherer):
     AGENTDECK_NO_SANDBOX=1 \"$IMAGE\""

printf '%s\n' "$MESSAGE" >&2

# A window for people who started it from the launcher (not for the login autostart).
quiet=0
for arg in "$@"; do
  [ "$arg" = "--hidden" ] && quiet=1
done
if [ "$quiet" = "0" ]; then
  if command -v zenity >/dev/null 2>&1; then
    LD_LIBRARY_PATH="" zenity --error --no-markup --title="AgentDeck" --text="$MESSAGE" >/dev/null 2>&1
  elif command -v kdialog >/dev/null 2>&1; then
    LD_LIBRARY_PATH="" kdialog --title "AgentDeck" --error "$MESSAGE" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then
    LD_LIBRARY_PATH="" notify-send "AgentDeck" "Die Chromium-Sandbox kann nicht starten. Details: Start im Terminal." >/dev/null 2>&1
  fi
fi
exit 1
