# Konfiguration

AgentDeck wird über eine optionale JSON-Datei und/oder `AGENTDECK_*`
Umgebungsvariablen konfiguriert. Gilt für den **Server**; die MCP-Bridge hat
nur drei eigene Variablen (siehe [MCP-BRIDGE.md](MCP-BRIDGE.md)).

## Wo gilt was?

Präzedenz (höchste zuerst):

1. Umgebungsvariablen (`AGENTDECK_*`)
2. `config.json` (Deep-Merge über die Defaults — fehlende Felder bleiben Default)
3. Eingebaute Defaults

Die Datei liegt standardmäßig unter `~/.config/agentdeck/config.json`
(XDG-konform); ein anderer Pfad via `AGENTDECK_CONFIG`. Nach Änderungen den
Server neu starten — es gibt kein Hot-Reload.

## Vollständige `config.json`-Referenz

```jsonc
{
  // Bind-Adresse. "0.0.0.0" = Heimnetz, "127.0.0.1" = nur lokal
  // (empfohlen hinter Reverse Proxy, siehe SECURITY.md).
  "host": "0.0.0.0",

  // HTTP-Port des Servers (REST + socket.io + ausgelieferte Web-App).
  "port": 8787,

  // State, Secrets, Attachments (wird angelegt, falls fehlt).
  "dataDir": "~/.local/share/agentdeck",

  // Sandbox-Root für ALLE Dateizugriffe (Browser, Download, Upload).
  "projectsRoot": "<dataDir>/projects",

  // Log-Ausgabe: "debug" | "info" | "warn" | "error".
  "logLevel": "info",

  // Hard-Kill für Agent-Läufe in ms (Standard 30 min).
  "maxRunMs": 1800000,

  // Max. Upload-Größe pro Anhang in Bytes (20 MB).
  "maxUploadBytes": 20971520,

  // Max. Größe einer APK für /api/apk/upload in Bytes (200 MB).
  "maxApkBytes": 209715200,

  // Zusätzliche CORS-Origins (Dev-Frontend, Capacitor-WebView).
  "corsOrigins": [
    "http://localhost:5173",
    "capacitor://localhost",
    "http://localhost"
  ],

  // Optionaler Fernzugriff ohne Portfreigabe (cloudflared als Child-Prozess).
  // Anleitung: REMOTE.md. Status erscheint in der Konsole und in der App
  // unter Settings → "Remote access".
  "tunnel": {
    "provider": "off",       // "off" (Default) | "cloudflared"
    "mode": "quick",         // "quick" (kein Konto, zufällige trycloudflare.com-URL) | "token" (Named Tunnel)
    "token": "",             // Tunnel-Token für mode "token"
    "hostname": "",          // optionaler fester Hostname (nur Anzeige in der UI)
    "binary": "cloudflared"  // Override, falls die Binary nicht auf dem PATH liegt
  },

  // Pro-Agent-Konfiguration. command = auszuführendes CLI.
  "agents": {
    "claude":      { "mode": "headless", "command": "claude" },
    "zcode":       { "mode": "auto",     "command": "zcode" },
    "antigravity": {
      "mode": "auto",
      "command": "flatpak run --command=antigravity com.google.Antigravity",
      "ideCommand": "flatpak run com.google.Antigravity"
    },
    "codex":       { "mode": "headless", "command": "codex" }
  }
}
```

### Feld-Übersicht

| Feld | Typ | Default | Bedeutung |
|---|---|---|---|
| `host` | string | `"0.0.0.0"` | Bind-Adresse des HTTP-Servers |
| `port` | number | `8787` | Port (REST, WS, Web-App) |
| `dataDir` | string | `~/.local/share/agentdeck` | State, Secrets, Attachments |
| `projectsRoot` | string | `<dataDir>/projects` | Sandbox-Root aller Dateizugriffe |
| `logLevel` | string | `"info"` | `debug`/`info`/`warn`/`error` |
| `maxRunMs` | number | `1800000` | Hard-Kill eines Agent-Runs (ms) |
| `maxUploadBytes` | number | `20971520` | Upload-Limit pro Anhang (Bytes) |
| `maxApkBytes` | number | `209715200` | Upload-Limit pro APK (Bytes) |
| `corsOrigins` | string[] | siehe oben | erlaubte CORS-Origins |
| `tunnel.provider` | string | `"off"` | `off` \| `cloudflared` |
| `tunnel.mode` | string | `"quick"` | `quick` (kein Konto) \| `token` (Named Tunnel) |
| `tunnel.token` | string | `""` | Tunnel-Token für `mode: "token"` |
| `tunnel.hostname` | string | `""` | fester Hostname (Anzeige in der App) |
| `tunnel.binary` | string | `"cloudflared"` | Binary/Command-Override |
| `agents.<id>.mode` | string | s. o. | `headless` \| `ide` \| `auto` \| `off` |
| `agents.<id>.command` | string | pro Agent | CLI-Befehl (Pfad erlaubt) |
| `agents.<id>.ideCommand` | string | abgeleitet | Befehl zum Öffnen der IDE |
| `voice.provider` | string | `"auto"` | Diktat-Backend: `auto` \| `openai` \| `groq` \| `command` \| `off` |
| `voice.apiKey` | string | `""` | API-Key (Fallback: `OPENAI_API_KEY` / `GROQ_API_KEY`) |
| `voice.baseUrl` | string | `""` | OpenAI-kompatible Base-URL (Default `https://api.openai.com/v1`) |
| `voice.model` | string | `""` | z. B. `whisper-1`, `gpt-4o-mini-transcribe`, `whisper-large-v3-turbo` |
| `voice.command` | string | `""` | lokaler Transkriber, Platzhalter `{wav}` `{file}` `{lang}` |
| `voice.language` | string | `""` | Standard-Sprache (ISO 639-1), leer = Gerätesprache |

### Diktat (Whisper) — optional

Auf dem Handy nutzt die App zuerst die On-Device-Spracherkennung (Chrome/PWA,
live). In der APK-WebView gibt es keine — dann nimmt die App kurz Audio auf und
der Server transkribiert. Beispiele:

```json
{ "voice": { "provider": "groq" } }                       // + GROQ_API_KEY im Env
{ "voice": { "command": "whisper-cli -m ~/models/ggml-base.bin -nt -l {lang} -f {wav}" } }
```

`{wav}` wird per `ffmpeg` als 16-kHz-Mono-WAV erzeugt (whisper.cpp braucht das).

### Agent-Modi

| Modus | Verhalten |
|---|---|
| `headless` | immer versuchen, Turns als Prozess auszuführen (Chat-Fernsteuerung) |
| `ide` | nie headless — Agent erscheint nur mit IDE-Launch („Projekt öffnen“) |
| `auto` | günstiger, GUI-freier Probe entscheidet: headless, wenn er klappt, sonst `ide` |
| `off` | Agent wird in der UI komplett versteckt |

Beispiel: ZCode hat keine verifizierte Headless-CLI. Mit `"mode": "headless"`
zwingst du ihn in ein Experiment (eigenes Risiko, siehe
[CONTRACT.md](CONTRACT.md)); mit `"mode": "ide"` verschwindet er aus der
Chat-Auswahl und bleibt nur als „Projekt öffnen“-Button.

## `AGENTDECK_*` Umgebungsvariablen

| Variable | überschreibt | Beispiel |
|---|---|---|
| `AGENTDECK_CONFIG` | Pfad der Konfigurationsdatei | `/etc/agentdeck/config.json` |
| `AGENTDECK_HOST` | `host` | `127.0.0.1` |
| `AGENTDECK_PORT` | `port` | `8787` |
| `AGENTDECK_DATA_DIR` | `dataDir` | `~/.local/share/agentdeck` |
| `AGENTDECK_PROJECTS_ROOT` | `projectsRoot` | `~/projekte` |
| `AGENTDECK_LOG_LEVEL` | `logLevel` | `debug` |
| `AGENTDECK_TUNNEL` | `tunnel.provider` | `cloudflared` (aktiviert) \| `off` |
| `AGENTDECK_TUNNEL_TOKEN` | `tunnel.token` (impliziert `mode: "token"`) | `<tunnel-token>` |
| `AGENTDECK_TUNNEL_BINARY` | `tunnel.binary` | `/usr/local/bin/cloudflared` |
| `AGENTDECK_VOICE_PROVIDER` | `voice.provider` | `groq` |
| `AGENTDECK_VOICE_COMMAND` | `voice.command` | `whisper-cli -m … -f {wav}` |
| `AGENTDECK_VOICE_API_KEY` | `voice.apiKey` | `sk-…` |
| `AGENTDECK_VOICE_MODEL` | `voice.model` | `whisper-1` |

Der Tunnel selbst ist in [REMOTE.md](REMOTE.md) erklärt (Quick-Tunnel,
Named Tunnel, Cloudflare Access).

## systemd — User-Service (Dauerbetrieb)

Beispiel-Unit: [`agentdeck.service`](agentdeck.service). Installation:

```bash
# 1. Einmalig bauen (oder scripts/install.sh)
npm run build

# 2. Unit installieren — im Checkout ausführen; trägt den Checkout-Pfad und
#    den absoluten node-Pfad ein (systemd kennt nvm/Homebrew-Pfade nicht).
mkdir -p ~/.config/systemd/user
sed -e "s|/usr/bin/env node|$(command -v node)|" -e "s|%h/agentdeck|$PWD|g" \
  docs/agentdeck.service > ~/.config/systemd/user/agentdeck.service

# 3. Aktivieren + starten
systemctl --user daemon-reload
systemctl --user enable --now agentdeck

# 4. Logs / Pairing-Code lesen
journalctl --user -u agentdeck -f
```

Der Pairing-Code steht nach dem Start auch in
`~/.local/share/agentdeck/pairing-code.txt`.

Hinweise:

- User-Units starten beim Login (`loginctl enable-linger "$USER"` macht sie
  auch ohne aktive Session bootfest).
- `Restart=on-failure` fängt Crashes ab; `AGENTDECK_PORT` in der Unit
  überschreibt wie gehabt die JSON-Konfiguration.
- Zum Aktualisieren: `git pull && npm run build && systemctl --user restart agentdeck`.

## Speicherlayout unter `dataDir`

Kurzreferenz (Details: [ARCHITECTURE.md](ARCHITECTURE.md)):

```
<dataDir>/
├── projects.json            # Projekt-Registry
├── devices.json             # gepaarte Geräte
├── jwt-secret               # HS256-Secret (0600) — löschen = alle Geräte abmelden
├── bridge-token             # Token für /api/bridge/run + APK-Uploads von CI/Skript (0600)
├── pairing-code.txt         # aktueller Pairing-Code
├── vapid.json               # Web-Push-Schlüssel (0600) — löschen = Geräte müssen Push neu aktivieren
├── push-subscriptions.json  # Push-Abos pro Gerät (0600)
├── apk/                     # agentdeck-latest.apk + apk.json (Version, SHA-256, …)
├── projects/                # Standard-projectsRoot
├── sessions/<id>/…          # meta.json + messages.jsonl
└── attachments/<sessionId>/…
```

Datensicherung = dieses Verzeichnis kopieren; Server vorher stoppen.
