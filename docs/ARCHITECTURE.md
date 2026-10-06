# Architektur

AgentDeck ist ein npm-Workspaces-Monorepo (ESM, Node ≥ 22). Der Server läuft
auf dem Rechner, auf dem auch die Agents arbeiten; die App (PWA oder APK) ist
ein dünner Client, der nur mit dem Server spricht — niemals direkt mit den
Agent-CLIs.

## Komponentenübersicht

```mermaid
flowchart LR
    subgraph Client["Handy oder Browser"]
        PWA["React-PWA<br/>(web/dist, mobil-first)"]
        APK["Android-APK<br/>(Capacitor-Wrapper, mobile/)"]
    end

    subgraph Host["Dein Rechner"]
        subgraph Server["Fastify + socket.io (server/)"]
            API["REST /api/*<br/>(JWT-geschützt)"]
            WS["WebSocket /socket.io"]
            AUTH["Pairing + JWT + Devices"]
            FILES["Datei-Sandbox<br/>(realpath &lt;= projectsRoot)"]
            TEAM["Team-Runner"]
            BRIDGE["MCP-Bridge<br/>(server/dist/mcp/bridge.js, stdio)"]
            subgraph Adapters["Agent-Adapter (Adapter-Regel: degrade gracefully)"]
                A1["claude-Adapter<br/>(stream-json)"]
                A2["codex-Adapter<br/>(exec --json)"]
                A3["zcode / antigravity<br/>(Probe + IDE-Launch)"]
            end
        end
        C1["claude CLI"]
        C2["codex CLI"]
        C3["zcode Desktop"]
        C4["antigravity (Flatpak)"]
        GIT["git / gh"]
    end

    PWA -->|"REST + WS, Bearer JWT"| API
    APK -->|"REST + WS, Bearer JWT"| API
    API --> AUTH
    API --> FILES
    API --> TEAM
    API --> Adapters
    WS --> PWA
    WS --> APK
    A1 --> C1
    A2 --> C2
    A3 --> C3
    A3 --> C4
    FILES --> GIT
    BRIDGE -->|"POST /api/bridge/run<br/>(nur localhost + Bridge-Token)"| API
    C1 -.->|"MCP über stdio"| BRIDGE
    C3 -.->|"MCP über stdio"| BRIDGE
```

**Adapter-Regel** (aus `docs/CONTRACT.md`): Jeder Adapter degradiert sanft.
`AgentInfo.available` spiegelt den Installationsstatus, `capabilities.headless`
die tatsächliche Fernsteuerbarkeit. Ein Probe darf **nie** als Nebeneffekt eine
GUI öffnen.

## Datenmodell

Alle Typen liegen in `@agentdeck/shared` (`packages/shared/src/`) und sind die
einzige Wahrheit für API- und WS-Payloads.

```mermaid
erDiagram
    PROJECT ||--o{ SESSION : enthaelt
    PROJECT ||--o{ TEAMRUN : "GET /api/team/runs?projectId="
    SESSION ||--o{ MESSAGE : schreibt
    TEAMRUN ||--|{ TEAMSTEP : besteht_aus
    TEAMSTEP ||--o| SESSION : "jeder Step = echte Session"

    PROJECT {
        string id PK
        string name
        string path "absolut, sandboxed auf projectsRoot"
        object git "remote, branch, dirty, ahead/behind"
    }
    SESSION {
        string id PK
        string projectId FK
        string agentId "claude|zcode|antigravity|codex"
        string status "idle|queued|running|error|stopped"
        string model
        string permissionMode "default|acceptEdits|plan|bypass"
        string externalSessionId "Resume-ID des Agent-CLIs"
    }
    MESSAGE {
        string id PK
        string sessionId FK
        string role "user|assistant|system|error"
        string text
        array attachments
        object usage "input/outputTokens, costUsd"
        string source "app|mcp|team"
    }
    TEAMRUN {
        string id PK
        string projectId FK
        string mode "sequence|parallel"
        string status "pending|running|done|error|stopped"
    }
    TEAMSTEP {
        string id PK
        string agentId
        string prompt
        string status "pending|running|done|error|skipped"
        string sessionId FK "optional, fuer Chat-View pro Step"
    }
```

## Lebenszyklus eines Turns

Ein Turn ist eine Nutzer-Nachricht plus die Antwort des Agents. Er läuft
asynchron; solange ein Turn aktiv ist, antwortet
`POST /api/sessions/:id/messages` mit **409**.

```mermaid
sequenceDiagram
    autonumber
    participant UI as PWA / APK
    participant API as Fastify (REST)
    participant AD as Adapter
    participant CLI as Agent-CLI (Kindprozess)
    participant WS as socket.io

    UI->>API: POST /api/sessions/:id/messages (SendTurnRequest)
    API->>API: Auth (JWT), Session-Status pruefen
    API-->>UI: SendTurnResponse { userMessage }
    API->>AD: Turn starten (text, attachmentIds, model, permissionMode)
    AD->>CLI: spawn, cwd = Projektpfad, stream-json / JSONL
    loop jede stdout-Zeile
        CLI-->>AD: natives Event (assistant / tool_use / result / ...)
        AD->>AD: normalisieren -> AgentEvent (packages/shared)
        AD-->>WS: session:event { sessionId, event }
        WS-->>UI: text-delta / tool-use / usage / raw
    end
    CLI-->>AD: result (finaler Text, usage)
    AD->>AD: ChatMessage in messages.jsonl persistieren
    AD-->>WS: session:event (message) + session:update (status: idle)
    WS-->>UI: fertige Nachricht + Session-Status
```

Nebenkanäle desselben Musters:

- **Interrupt:** Client emittiert `session:interrupt` (mit Ack); Server killt
  den Prozess (SIGINT → 3 s Schonfrist → SIGKILL).
- **Timeout:** `maxRunMs` (Standard 30 min) killt harte Läufer.
- **Resume:** `externalSessionId` der Session wird an `--resume` bzw.
  `codex exec resume` durchgereicht.

## WebSocket-Protokoll

socket.io unter `/socket.io`, Handshake mit `auth.token` (JWT). Events sind in
`packages/shared/src/events.ts` typisiert:

| Richtung | Event | Zweck |
|---|---|---|
| Server → Client | `session:event` | Live-`AgentEvent`-Stream einer Session; Events eines Runs tragen `run` + `seq`, passend zum `draft` aus `GET /api/sessions/:id` (Einstieg mitten im Run) |
| Server → Client | `session:update` | Session-Metadaten (Status, Modell, …) |
| Server → Client | `project:update` | Projekt geändert / Clone-Fortschritt |
| Server → Client | `agent:update` | Verfügbarkeit/Capabilities geändert |
| Server → Client | `team:update` | Team-Run-Fortschritt |
| Server → Client | `notify` | Toast (info/warn/error) |
| Client → Server | `session:interrupt` | Turn abbrechen (mit Ack) |

Jedes mutierende REST-Endpoint emittiert danach das passende WS-Update.

## Speicherlayout

Alles liegt unter `dataDir` (Standard `~/.local/share/agentdeck`, siehe
[CONFIG.md](CONFIG.md)):

```
~/.local/share/agentdeck/
├── projects.json                     # Projekt-Registry
├── devices.json                      # gepaarte Geräte
├── jwt-secret                        # HS256-Secret (0600)
├── bridge-token                      # Token für /api/bridge/run (0600)
├── pairing-code.txt                  # aktueller Pairing-Code
├── projects/                         # Standard-projectsRoot (Sandbox)
├── stats.sqlite                      # Aktivität: jeder Agent-Lauf + Abo-Limits im Zeitverlauf (node:sqlite)
├── sessions/<id>/meta.json           # Session-Metadaten
├── sessions/<id>/messages.jsonl      # Chat-Verlauf (append-only)
└── attachments/<sessionId>/<fileId>__<safe-name>
```

Der Chat-Verlauf ist damit dateibasiert und portabel; löschen einer Session
löscht `sessions/<id>/` samt Attachments.

## Team-Run-Ablauf

`POST /api/team/runs` erzeugt einen `TeamRun`; **jeder Step wird eine echte
Session** — der Verlauf jedes Steps bleibt also im Chat browsable.

```mermaid
sequenceDiagram
    autonumber
    participant UI as App
    participant TR as Team-Runner
    participant S1 as Session A (z. B. claude)
    participant S2 as Session B (z. B. codex)

    UI->>TR: POST /api/team/runs { mode, steps }
    TR-->>UI: team:update (status: running, step 1: running)
    TR->>S1: Turn ausfuehren (Prompt aus step[0])
    S1-->>TR: Ergebnis
    TR-->>UI: team:update (step 1: done)
    alt mode = sequence
        TR->>TR: passContext? vorherige Ergebnisse an Prompt anhaengen
        TR->>S2: naechster Step
        S2-->>TR: Ergebnis
    else mode = parallel
        par alle Steps gleichzeitig
            TR->>S2: Step k starten
        end
    end
    TR-->>UI: team:update (status: done)
```

Semantik: `sequence` + `passContext: true` prependet die Ergebnisse der
vorherigen Steps jedem Prompt (Kette: „implementiere → reviewe → fixe").
`parallel` startet alle Steps gleichzeitig — sinnvoll für vergleichende Aufgaben.
Fehler in einem Step markieren den Run als `error`; ein `sequence`-Run bricht
ab, ein `parallel`-Run lässt die übrigen Steps laufen.

## MCP-Bridge-Schleife (Cross-Agent-Subagents)

Die Bridge ist ein eigener stdio-Prozess, den beliebige Agent-CLIs als
MCP-Server registrieren. Damit ruft z. B. Claude Code ZCode auf — Details in
[MCP-BRIDGE.md](MCP-BRIDGE.md).

```mermaid
sequenceDiagram
    autonumber
    participant A as Claude Code (Orchestrator)
    participant B as agentdeck-mcp (stdio)
    participant S as AgentDeck-Server
    participant Z as zcode (Ziel-Agent)

    A->>B: tools/call agentdeck_delegate { agent, prompt }
    B->>S: POST /api/bridge/run (localhost + Bridge-Token)
    S->>Z: Adapter startet Turn
    Z-->>S: finaler Antworttext
    S-->>B: { ok, text, sessionId }
    B-->>A: Tool-Result -> Claude arbeitet weiter
```

Die erzeugten Sessions erscheinen mit `source: "mcp"` im Verlauf und sind
normal in der App sichtbar.
