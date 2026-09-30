#!/usr/bin/env bash
# AgentDeck — permanenten Cloudflare-Tunnel einrichten (feste URL, nie wieder ändern)
#
# Quick-Tunnels (*.trycloudflare.com) wechseln bei jedem Serverstart.
# Dieses Script richtet einen benannten Tunnel mit fester URL ein:
#   1. cloudflared login (öffnet Browser; Cloudflare-Konto + Domain nötig)
#   2. Tunnel erstellen + DNS-Route anlegen (z.B. agentdeck.deinedomain.de)
#   3. Token in ~/.config/agentdeck/config.json eintragen (Backup wird erstellt)
#
# Danach: Server neu starten — die URL bleibt dauerhaft gleich.
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
if [ ! -t 1 ] || [ -n "${NO_COLOR:-}" ]; then BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi

say()  { printf '%s\n' "${GREEN}==>${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}WARN:${RESET} $*"; }
die()  { printf '%s\n' "${RED}FEHLER:${RESET} $*" >&2; exit 1; }

CONFIG_FILE="${AGENTDECK_CONFIG:-$HOME/.config/agentdeck/config.json}"

command -v cloudflared >/dev/null 2>&1 \
  || die "cloudflared nicht gefunden. Installation: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"

printf '%s\n' "${BOLD}AgentDeck — permanenter Cloudflare-Tunnel${RESET}"
printf '%s\n' "Du brauchst: ein (kostenloses) Cloudflare-Konto mit einer dort"
printf '%s\n' "verwalteten Domain. Die Tunnel-URL wird fest, z.B.:"
printf '%s\n' "  https://agentdeck.<deine-domain>.de"
printf '%s\n' "Alternative ohne Domain: Tailscale (siehe docs/REMOTE.md)"
printf '%s\n' ""
read -r -p "Weiter? [J/n] " ok
[[ "${ok:-J}" =~ ^[JjYy]?$ ]] || exit 0

say "Schritt 1/4: cloudflared login (Browser öffnet sich — Domain auswählen)"
cloudflared tunnel login
[ -f "$HOME/.cloudflared/cert.pem" ] || die "Login fehlgeschlagen (cert.pem nicht gefunden)."

read -r -p "Tunnel-Name [agentdeck]: " TUNNEL_NAME
TUNNEL_NAME="${TUNNEL_NAME:-agentdeck}"
read -r -p "Feste Hostname (z.B. agentdeck.deinedomain.de): " HOSTNAME_IN
[ -n "$HOSTNAME_IN" ] || die "Hostname darf nicht leer sein."
case "$HOSTNAME_IN" in
  http*) die "Nur den Hostname eingeben, ohne https://" ;;
esac
[[ "$HOSTNAME_IN" =~ ^[a-zA-Z0-9.-]+$ ]] || die "Ungültiger Hostname."

say "Schritt 2/4: Tunnel '$TUNNEL_NAME' erstellen"
cloudflared tunnel create "$TUNNEL_NAME"

say "Schritt 3/4: DNS-Route $HOSTNAME_IN -> Tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_IN" \
  || warn "Route existiert evtl. schon — fahre fort."

say "Schritt 4/4: config.json schreiben (Modus: named, feste URL)"
ls "$HOME/.cloudflared/"*.json >/dev/null 2>&1 \
  || warn "Keine Credentials-Datei in ~/.cloudflared gefunden — 'tunnel run' sucht sie später selbst."

mkdir -p "$(dirname "$CONFIG_FILE")"
if [ -f "$CONFIG_FILE" ]; then
  BACKUP="$CONFIG_FILE.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG_FILE" "$BACKUP"
  say "Backup erstellt: $BACKUP"
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "$CONFIG_FILE" "$TUNNEL_NAME" "$HOSTNAME_IN" <<'PY'
import json, sys
path, name, hostname = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
cfg["tunnel"] = {"provider": "cloudflared", "mode": "named", "name": name, "hostname": hostname}
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
else
  node - "$CONFIG_FILE" "$TUNNEL_NAME" "$HOSTNAME_IN" <<'JS'
const fs = require("fs");
const [path, name, hostname] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.tunnel = { provider: "cloudflared", mode: "named", name, hostname };
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
JS
fi

printf '%s\n' ""
printf '%s\n' "${GREEN}${BOLD}Fertig! Deine permanente URL:${RESET}"
printf '%s\n' "  ${BOLD}https://%s${RESET}" "$HOSTNAME_IN"
printf '%s\n' ""
printf '%s\n' "Nächste Schritte:"
printf '%s\n' "  1. Server neu starten (systemctl --user restart agentdeck oder npm start)"
printf '%s\n' "  2. Auf dem Handy einmalig öffnen/scannen: https://$HOSTNAME_IN/?server=https://$HOSTNAME_IN"
printf '%s\n' "     — die App übernimmt die Adresse automatisch. Danach nie wieder ändern."
