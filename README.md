# AgentDeck

**Die Fernbedienung für deine Coding-Agents — vom Handy aus.**

AgentDeck läuft auf dem Rechner, auf dem deine Agents arbeiten, und stellt eine
mobil-optimierte Oberfläche bereit: Chat-Steuerung, Modellwechsel, Datei-Browser,
Git, Terminals mit Agent-Launchern, Push-Benachrichtigungen und Diktat — für
**Claude Code**, **Codex**, **OpenCode**, **Gemini CLI**, **ZCode** und **Antigravity**.

[![CI](https://github.com/Ninjalama1337/agentdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Ninjalama1337/agentdeck/actions/workflows/ci.yml)
[![Android APK](https://github.com/Ninjalama1337/agentdeck/actions/workflows/android.yml/badge.svg)](https://github.com/Ninjalama1337/agentdeck/actions/workflows/android.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Screenshots folgen.** Bis dahin der Überblick als Diagramm — versprochen ist
> hier nichts passiert, was nicht wirklich im Repo steht.

```
┌────────────────────┐    REST + WebSocket     ┌──────────────────────────────────┐
│   Handy (PWA/APK)  │ ──────────────────────► │  Fastify-Server (dein Rechner)   │
│                    │ ◄────────────────────── │   ├─ Adapter ──► claude (CLI)    │
│  Chat · Dateien    │    Pairing → JWT        │   ├─ Adapter ──► codex (CLI)     │
│  Git · Team-Runs   │                         │   ├─ IDE-Launch ► zcode          │
└────────────────────┘                         │   ├─ gh/git ────► GitHub         │
        ▲                                      │   └─ MCP-Bridge ◄─ Agent ruft    │
        └──── gleiche UI im Desktop-Browser ───┴───── den nächsten Agent ────────┘
```

---

## Was ist AgentDeck?

Du startest einen kleinen Server auf deinem Arbeitsrechner und pairst dein
Handy einmalig per 6-stelligem Code. Danach steuerst du von unterwegs die
Agents, die **lokal mit vollem Kontext** arbeiten — mit deinen Repos, deiner
`gh`-Anmeldung und deinen CLIs. Alles self-hosted, keine Cloud dazwischen.

**Funktionen**

- **Agent-Terminals mit einem Tipp** — Claude Code, Codex, OpenCode, Gemini CLI,
  Aider (und lazygit/btop) direkt als echte TUI im Handy-Terminal starten:
  *Neu*, *Weiter*, *Auswählen* oder *YOLO*. Eingabezeile mit Autokorrektur und
  Diktat, Tastenleiste (Ctrl, Esc, ⇧Tab, Pfeile, ^C …), Schnellantworten für
  Rechte-Abfragen (1/2/3, y/n) und Slash-Befehle je Agent, Pinch-Zoom.
  Scrollen in der History per Wischgeste oder Scroll-Tasten.
- **Benachrichtigungen** — „Claude ist fertig“, „Run fehlgeschlagen“,
  „Terminal wartet auf dich“ (Claude Code meldet Rückfragen und Ende selbst per
  Hook, sonst Bell, OSC 9/777 oder Stille nach Arbeit):
  In-App-Inbox, Web Push bei geschlossener App (HTTPS/Tunnel), lokale
  Notifications in der APK. Tippen springt direkt in Session oder Terminal.
- **Diktat überall** — Chat, Terminal-Eingabe und Commit-Message; live über die
  Geräteerkennung oder per Whisper auf dem Server (OpenAI, Groq, whisper.cpp).
- **Git-Tab** — geänderte Dateien mit farbigem Diff, einzelne Dateien auswählen
  oder verwerfen, KI-Commit-Message aus dem Diff, Commit & Push, Pull/Fetch,
  Branches wechseln/anlegen, Historie mit Commit-Diffs, GitHub-Clone.
- **Chat-Steuerung aller Agents** — Turns senden, Live-Streaming der Antwort
  (Text, Tool-Nutzung, Token-/Kosten-Verbrauch), Unterbrechen per Tap. Wer
  die App mitten in einer Antwort wieder öffnet, sieht den bisherigen Stand
  und liest live weiter; ungesendeter Text und Anhänge bleiben pro Session
  erhalten.
- **Rechte-Abfragen im Chat** — will Claude Code einen Befehl ausführen oder
  eine Datei ändern, der es nicht ohne Zustimmung darf, erscheint die Anfrage
  im Chat: *Allow*, *Deny* oder *Always allow*, mit dem vollständigen Befehl
  bzw. der Änderung zum Aufklappen. Rückfragen des Agents mit Auswahloptionen
  beantwortest du genauso. Dazu kommt eine Benachrichtigung; in der APK
  mit Allow/Deny direkt auf der Benachrichtigung.
- **Aktivität & Kosten** — der Server hält jeden Agent-Lauf in einer
  SQLite-Datenbank fest (Chat, Routinen, Team-Runs, Terminal-Turns): Agent,
  Modell, Projekt, Dauer, Tokens, Tool-Aufrufe und Kosten. Die App zeigt daraus
  unter *Activity*, welcher Agent wie viel erledigt hat — pro Tag, Agent,
  Projekt und Modell, dazu die Abo-Limits im Zeitverlauf und die einzelnen
  Läufe. Kosten sind der API-Gegenwert, wie ihn die CLI meldet; für
  Terminal-Turns liefert nur Claude Code Tokens (aus seinem Transkript).
- **Modell-Wechsel in 2 Taps** — Pro-Session Modell + Permission-Mode, mit
  Presets pro Agent.
- **Projekte & GitHub** — Projekte registrieren, aus GitHub klonen (`gh`),
  Status/Commit/Push direkt aus der App.
- **Datei-Browser mit Download** — sandboxed auf `projectsRoot`, Downloads über
  signierte Einmal-Tokens.
- **Bild-/Screenshot-Anhang im Chat** — Screenshots vom Handy direkt in den
  Agent-Turn (z. B. „Mach es wie auf dem Bild").
- **Team-Runs** — mehrere Agents als Pipeline, sequenziell (mit
  Kontext-Weitergabe) oder parallel.
- **MCP-Bridge** — jeder Agent kann jeden anderen als Subagent aufrufen
  („Lass zcode das Review machen").
- **Agent-Verwaltung aus der App** — Updates triggern, fehlende Agents
  installieren und Logins starten, alles ohne Neustart: Live-Konsole in der
  App, danach automatischer Re-Detect (Details: Tabelle unten).
- **Remote-Zugriff ohne Portfreigabe** — optionaler Cloudflare-Tunnel
  (Quick-Tunnel mit einer Config-Zeile, Named Tunnel mit fester URL); Status
  und Adresse sichtbar in der App.
- **Mehrere Server in einer App** — weitere AgentDeck-Server hinzufügen und
  mit einem Tipp in der Kopfleiste wechseln; jeder Server behält seinen eigenen
  Login, neu pairen ist beim Wechsel nicht nötig. Benachrichtigungen kommen vom
  gerade verbundenen Server.
- **Server-Update per Tipp** — Releases entstehen auf GitHub (Tag `vX.Y.Z`,
  getestet und mit APK gebaut). Die App zeigt unter Settings, welche Version
  der Server fährt und ob es eine neuere gibt; ein Tipp bringt den Server auf
  das Release, hinterlegt die passende APK und startet ihn neu
  ([docs/RELEASES.md](docs/RELEASES.md)).
- **APK-Self-Update** — der Server verteilt die Android-App selbst
  (`/api/apk/latest`); die App prüft beim Start gegen `/api/apk/info` und
  bietet Updates mit einem Tap zum Download an.
- **PWA + APK** — installierbar als Progressive Web App oder als echte
  Android-APK (Capacitor 7, via GitHub Actions gebaut).

## Quickstart

Voraussetzungen: **Node ≥ 20** und npm. Die Agent-CLIs (`claude`, `codex`, …)
und `gh` sind optional — nicht installierte Agents werden sauber als
*unavailable* angezeigt statt zu crashen.

Unter Linux kompiliert `npm install` das Terminal-Modul `node-pty` (das Paket
bringt kein fertiges Linux-Binary mit). Dafür müssen `python3`, `make` und ein
C++-Compiler installiert sein — z. B. `sudo apt install build-essential python3`
oder `sudo dnf install gcc-c++ make python3`. Empfohlen ist außerdem `tmux`:
damit überleben Terminals einen Server-Neustart, ohne tmux enden sie mit ihm.

```bash
npm install        # Workspaces installieren
npm run build      # shared + server + web bauen
npm start          # Server auf :8787 starten
```

Die Konsole zeigt den **Pairing-Code** (6-stellig, auch als QR) und die
LAN-Adresse. Dann:

1. Handy ins **gleiche WLAN**.
2. `http://<lan-ip>:8787` öffnen, Code eingeben, Geräte-Schema vergeben.
3. Entweder **PWA installieren** (Chrome-Menü → *Zum Startbildschirm*) oder die
   **APK** aus den GitHub Actions laden — siehe
   [docs/ANDROID.md](docs/ANDROID.md).

Bequemer: `scripts/install.sh` erledigt Install + Build, `scripts/dev.sh`
startet Server und Web-Dev-Server parallel. Für den Dauerbetrieb gibt es ein
systemd-User-Service-Beispiel in [docs/CONFIG.md](docs/CONFIG.md).

## Agent-Unterstützung

| Agent | Fernsteuerung | Standard-Modus | Hinweise |
|---|---|---|---|
| **Claude Code** | voll headless | `headless` | stream-json, Resume, Bildanhänge, Permission-Modes |
| **ZCode** | über MCP-Bridge | `ide` | Desktop-App ohne Headless-CLI: Projekt wird geöffnet, Steuerung als Orchestrator über die Bridge |
| **Antigravity** | Sonde + IDE-Fallback | `auto` | Headless nicht verifiziert — günstiger Probe-Versuch, sonst öffnet die IDE (`flatpak run …`) |
| **Codex** | headless | `headless` | `codex exec --json`, Resume, `-C <dir>` |

Die Modi (`headless` / `ide` / `auto` / `off`) stellst du pro Agent in
`~/.config/agentdeck/config.json` unter `agents.<id>.mode` um — alle Details in
[docs/CONFIG.md](docs/CONFIG.md).

## Sicherheit (Kurzfassung)

- **Pairing-Code** nur einmalig, rotiert nach jeder Verwendung. Aus dem
  LAN/localhost genügt der Code; von außerhalb (Tunnel, Proxy) muss zusätzlich
  ein bereits gepaartes Gerät die Anfrage in der App erlauben. Den aktuellen
  Code zeigt die App unter Settings → Paired devices.
- Danach **JWT (HS256, 30 Tage)** für REST und WebSocket; Geräte lassen sich
  einzeln abmelden.
- **Datei-Sandbox:** jeder Pfad wird aufgelöst (`realpath`) und muss in
  `projectsRoot` bleiben — kein Traversal, kein Symlink-Escape.
- **Signierte Download-Tokens** (TTL 120 s), weil Android-Download-Manager
  keine Header mitsenden.
- Agent-Läufe haben ein **Hard-Kill-Limit** (`maxRunMs`).
- Empfehlung: nur im LAN oder über VPN (z. B. Tailscale) betreiben. Für
  Fernzugriff mit TLS gibt es ein Caddy-Beispiel in
  [docs/SECURITY.md](docs/SECURITY.md).

## Remote-Zugriff & APK-Download

Für unterwegs muss der Router nicht angefasst werden — der Server kann sich
seinen Weg nach draußen selbst bauen. Die komplette Anleitung (inkl.
Cloudflare Access und Security-Checkliste) steht in
[docs/REMOTE.md](docs/REMOTE.md); hier die Kurzfassung:

| Weg | Aufwand | Wann |
|---|---|---|
| **Tailscale / WireGuard** | App auf Handy + Rechner installieren | empfohlen — kein öffentlicher Endpoint, nur deine Geräte |
| **Cloudflare Tunnel** | `"tunnel": { "provider": "cloudflared", "mode": "quick" }` in der Config (oder `AGENTDECK_TUNNEL=cloudflared`) | öffentliche HTTPS-URL ohne Portfreigabe; per Named Tunnel mit fester Adresse |
| **Reverse Proxy + TLS** | Caddy/Nginx + eigene Domain | wenn ohnehin eine Domain existiert (Caddy-Beispiel: [docs/SECURITY.md](docs/SECURITY.md)) |

**Nie wieder die URL ändern?** Quick-Tunnel-URLs wechseln bei jedem Start —
abhilfe schaffen zwei Wege: einmalig `scripts/setup-tunnel.sh` (Named Tunnel
mit fester Adresse wie `agentdeck.deinedomain.de`) oder Tailscale (feste
Tailnet-IP). Übergangsweise: Der QR-Code in der Server-Konsole öffnet die App
gleich mit richtiger Adresse (`?server=…` wird automatisch übernommen).

Derselbe Server verteilt auch die **Android-APK**: Pairing-Seite und Settings
bieten den Download an (`/api/apk/latest`), und gepaarte Geräte zeigen beim
Start ein Update-Banner, sobald der Server eine neuere APK hält. Neue Builds
landen automatisch per CI (Repo-Secrets `AGENTDECK_URL` +
`AGENTDECK_BRIDGE_TOKEN`) oder lokal per
`scripts/upload-apk.sh <apk> [version]` auf dem Server — Details in
[docs/ANDROID.md](docs/ANDROID.md#updates--apk-verteilung).

## MCP-Bridge einrichten

Die Bridge (`server/dist/mcp/bridge.js`) ist ein stdio-MCP-Server. Registriere
sie bei einem Agent, und dieser Agent kann alle anderen als Subagent nutzen.

Claude Code (im Repo-Root ausführen):

```bash
claude mcp add agentdeck -- "$PWD/server/dist/mcp/bridge.js"
```

ZCode / Antigravity (JSON-Konfiguration):

```json
{
  "mcpServers": {
    "agentdeck": {
      "command": "node",
      "args": ["/absoluter/pfad/zu/agentdeck/server/dist/mcp/bridge.js"],
      "env": { "AGENTDECK_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

Was `agentdeck_delegate` kann — Beispiel-Prompt im Claude-Chat:

> Schau dir den Fehler in `server/src/…` an und lass zcode das Review machen,
> bevor du den Fix committest.

Claude delegiert den Review-Turn an ZCode, wartet auf das Ergebnis und arbeitet
damit weiter. Alle Details (Tools, Tokens, Codex-Registrierung):
[docs/MCP-BRIDGE.md](docs/MCP-BRIDGE.md).

## Repository-Struktur

| Pfad | Workspace | Inhalt |
|---|---|---|
| `packages/shared` | `@agentdeck/shared` | TS-Typen für REST-API + WS-Protokoll |
| `server/` | server | Fastify + socket.io, Agent-Adapter, MCP-Bridge |
| `web/` | web | React-PWA (mobil-first), wird vom Server ausgeliefert |
| `mobile/` | agentdeck-mobile | Capacitor-7-Wrapper → Android-APK ([mobile/README.md](mobile/README.md)) |
| `docs/` | — | [Architektur](docs/ARCHITECTURE.md) · [Sicherheit](docs/SECURITY.md) · [Remote-Zugriff](docs/REMOTE.md) · [Android](docs/ANDROID.md) · [Releases & Updates](docs/RELEASES.md) · [MCP-Bridge](docs/MCP-BRIDGE.md) · [Konfiguration](docs/CONFIG.md) |
| `scripts/` | — | Helfer-Skripte (siehe unten) |

## Skripte

| Befehl | Zweck |
|---|---|
| `scripts/install.sh` | Abhängigkeiten installieren + alles bauen, mit Hinweisen |
| `scripts/dev.sh` | Server (Hot Reload) + Vite-Dev-Server parallel, mit `[server]`/`[web]`-Präfixen |
| `scripts/build-android.sh` | Android-APK bauen (prüft SDK und `android/`-Ordner) |
| `scripts/upload-apk.sh` | gebaute APK an den Server hochladen (`POST /api/apk/upload`) |
| `scripts/release.sh` | Release anlegen: testen, `vX.Y.Z` taggen und pushen — GitHub baut APK und Release (`--wait` wartet darauf) |
| `scripts/update.sh` | diesen Checkout auf das neueste Release bringen, bauen, APK hinterlegen, Server neu starten |
| `scripts/restart.sh` | laufenden Server neu starten (Terminals in tmux bleiben); Log: `~/.local/state/agentdeck/server.log` oder `AGENTDECK_LOG_FILE` |
| `npm start` | gebauten Server starten (`server/dist/index.js`) |
| `npm test` | Tests (Server und Web-App) |
| `npm run typecheck` | Typecheck über alle Workspaces |

## Roadmap

- [ ] APK-Signierung inkl. Keystore-Workflow (Release-APK ist aktuell unsigniert)
- [x] Benachrichtigungen, wenn ein langer Turn fertig ist
- [ ] Mehrere Projekte in einem Team-Run
- [ ] Optionale E2E-Verschlüsselung für Fernzugriff ohne TLS-Terminierung

## Lizenz

[MIT](LICENSE) — © 2026 Ninjalama1337
