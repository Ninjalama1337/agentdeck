# AgentDeck — Binding Contract (v0.1)

This document plus `packages/shared/src/**` is the **source of truth** for every
workspace in this monorepo. If code and contract disagree, the contract wins.

AgentDeck is a self-hosted control deck that lets you drive coding agents on
your machine from a mobile app (PWA / Android APK):

- **Agents:** Claude Code (fully headless), ZCode (IDE mode + MCP bridge),
  Antigravity (headless probe + IDE fallback), Codex (headless).
- **Backend:** Fastify + socket.io on the machine where the agents run.
- **Frontend:** React PWA, mobile-first, served by the backend.
- **Cross-agent work:** Team runs (sequential/parallel pipelines) and an MCP
  bridge so any agent can delegate to any other agent as a subagent.

## Workspaces

| Path | Owner | Contents |
|---|---|---|
| `packages/shared` | root (fixed) | TS types for API + WS protocol |
| `server` | backend agent | Fastify server, adapters, MCP bridge |
| `web` | frontend agent | React PWA |
| `mobile` | mobile agent | Capacitor wrapper + APK build |
| `docs`, `scripts`, `.github`, `README.md` | mobile agent | docs, CI |

## Environment facts (verified on this machine, 2026-09-30)

- Node v22.23.2, npm 10.9.8, npm registry reachable.
- `claude` — Claude Code **2.1.285** at
  `~/.nvm/versions/node/v22.23.2/bin/claude`. Full headless support:
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages`,
  `--model <id>`, `--permission-mode <default|acceptEdits|plan|bypassPermissions>`,
  `--resume <sessionId>`, `--dangerously-skip-permissions`, cwd defines project.
  Permission questions (verified in 2.1.291): with `--permission-prompt-tool stdio`
  and stdin kept open, a tool call that needs approval arrives on stdout as
  `{type:"control_request",request_id,request:{subtype:"can_use_tool",tool_name,
  input,permission_suggestions,tool_use_id}}`; the answer goes to stdin as
  `{type:"control_response",response:{subtype:"success",request_id,response:
  {behavior:"allow",updatedInput[,updatedPermissions]} | {behavior:"deny",message}}}`.
  `AskUserQuestion` comes the same way and is answered with
  `updatedInput.answers = {<question>: <label>}`. The CLI exits once stdin is
  closed after the `result` line.
  Thinking effort: `--effort <low|medium|high>` (verified in 2.1.285 help).
  Subscription usage (verified): `claude -p "/usage"` prints plan usage —
  "Current session: N% used · resets <date>", "Current week (all models):
  N% used · resets <date>", "Last 24h · N requests · N sessions",
  "Last 7d · N requests · N sessions".
  stream-json stdout lines: `{type:"system",subtype:"init",session_id,...}`,
  `{type:"assistant",message:{content:[{type:"text"|"thinking"|"tool_use",...}]}}`,
  `{type:"user",message:{content:[{type:"tool_result",...}]}}`,
  `{type:"result",subtype:"success"|"error",result,usage,...}`.
  With `--include-partial-messages` (verified in 2.1.289) the text arrives as
  it is written: `{type:"stream_event",parent_tool_use_id,event}` lines carry
  the raw API stream — `message_start` (`message.id`), `content_block_delta`
  with `text_delta` / `thinking_delta` — followed by the usual `assistant`
  line with the finished block (same `message.id`), which the adapter then
  skips. Sub-agent chunks (`parent_tool_use_id` set) are not streamed; their
  text is taken from the `assistant` line.
  `thinking` blocks stream as `thinking-delta` and are persisted SEPARATELY on
  the assistant `ChatMessage.thinking` — never mixed into `text`.
  Image input: user-turn content block `{"type":"image","source":{"type":"base64","media_type":...,"data":...}}`.
- `zcode` — **Headless CLI available** (built from github.com/zai-org/ZCode,
  `apps/zcode-cli` ≥ 0.16.x): `-p <prompt>` (prompt as flag value),
  `--output-format text|json|stream-json`, `--mode build|edit|plan|yolo`,
  `--resume <id>`, `--cwd <dir>`, `--verbose`. stdout = one JSON SessionEvent
  per line (`{type:'session_created'|'model_streaming'|'assistant_message'|
  'reasoning_start'|'reasoning_delta'|'reasoning_end'|'tool_call_started'|
  'tool_call_result'|'turn_complete'|'turn_error'|…', payload}` — wire types
  use dot-notation; reasoning_* maps to `thinking-delta`). No image input.
  **Model + thinking effort** have no CLI flags: the adapter atomically
  patches `defaultModelSelection {providerId, modelId, options.reasoningLevel}`
  in `~/.zcode/v2/provider_config.json` before each run (server-wide default,
  provider binding preserved; failure degrades to a run `notice`). Model
  presets: GLM-5.3 / GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo (+ custom);
  efforts: default/low/medium/high → reasoningLevel.
  Detection: `--version` prints a bare semver without Electron logs → CLI
  (headless); if the binary is the desktop AppImage (Electron log markers) the
  adapter falls back to IDE mode + MCP bridge participation.
- `antigravity` — Flatpak `com.google.Antigravity` **2.17.0**, CLI wrapper at
  `~/.local/share/flatpak/app/com.google.Antigravity/current/active/files/bin/antigravity`
  (invoke as `flatpak run --command=antigravity com.google.Antigravity`).
  Headless capability unverified → probe + IDE fallback (`flatpak run
  com.google.Antigravity <path>`), MCP bridge participation.
- `codex` — codex-cli **0.158.0** at `~/.local/bin/codex`.
  Headless: `codex exec --json <prompt>` (JSONL events on stdout), `-C <dir>`,
  `-m <model>`, resume: `codex exec resume <id>`.
- `gh` — authenticated (Ninjalama1337), `git` present.
- **Adapter rule:** every adapter must degrade gracefully. `AgentInfo.available`
  reflects install status; `AgentInfo.capabilities.headless` reflects remote
  chat control. Never spawn a GUI app as a side effect of probing.

## Configuration

Env prefix `AGENTDECK_`, optional JSON config at `~/.config/agentdeck/config.json`
(deep-merged over defaults, env wins). Schema:

```jsonc
{
  "host": "0.0.0.0",
  "port": 8787,
  "dataDir": "~/.local/share/agentdeck",     // state, secrets, attachments
  "projectsRoot": "<dataDir>/projects",      // sandbox root for ALL file access
  "logLevel": "info",
  "maxRunMs": 1800000,                        // hard kill for agent runs
  "maxUploadBytes": 20971520,                 // 20 MB per attachment
  "corsOrigins": ["http://localhost:5173", "capacitor://localhost", "http://localhost"],
  "agents": {
    "claude":      { "mode": "headless", "command": "claude" },
    "zcode":       { "mode": "auto",    "command": "zcode" },
    "antigravity": { "mode": "auto",    "command": "flatpak run --command=antigravity com.google.Antigravity", "ideCommand": "flatpak run com.google.Antigravity" },
    "codex":       { "mode": "headless", "command": "codex" }
  },
  "tunnel": {
    "provider": "cloudflared",              // "off" (default) | "cloudflared"
    "mode": "quick",                        // "quick" (no account, random trycloudflare.com URL) | "token" (dashboard connector token) | "named" (fixed URL via tunnel name — scripts/setup-tunnel.sh)
    "token": "",                            // cloudflared tunnel token (mode "token")
    "name": "",                             // tunnel name (mode "named"; requires prior `cloudflared tunnel login` + `create`)
    "credentialsFile": "",                  // optional override for mode "named"
    "hostname": "",                         // fixed hostname for named/token modes (becomes publicUrl)
    "binary": "cloudflared"                 // command override if not on PATH
  }
}
```

Tunnel env overrides: `AGENTDECK_TUNNEL=cloudflared|off`,
`AGENTDECK_TUNNEL_TOKEN=<token>` (implies mode `token`),
`AGENTDECK_TUNNEL_BINARY=<path>`.

Storage layout under `dataDir`:
`projects.json`, `devices.json`, `jwt-secret` (0600), `bridge-token` (0600),
`pairing-code.txt`, `sessions/<id>/meta.json`, `sessions/<id>/messages.jsonl`,
`attachments/<sessionId>/<fileId>__<safe-name>`. The Android APK is not stored
here — it is downloaded from the public GitHub release.
```

Adapter `mode`: `headless` (always try), `ide` (never headless),
`auto` (headless if a cheap non-GUI probe succeeds, else ide), `off` (hidden).

Storage layout under `dataDir`:
`projects.json`, `devices.json`, `jwt-secret` (0600), `bridge-token` (0600),
`pairing-code.txt`, `sessions/<id>/meta.json`, `sessions/<id>/messages.jsonl`,
`attachments/<sessionId>/<fileId>__<safe-name>`.

## Auth & security

1. On first start the server generates a **6-digit pairing code**, prints it
   (with QR) to the console and writes it to `dataDir/pairing-code.txt`.
2. `POST /api/pair {code, deviceName}` → on success issues a **JWT (HS256,
   30d)** with `deviceId`, rotates the code, registers the device. Max 5
   failed attempts per IP / 10 min (429). From the LAN or localhost the code
   alone pairs. A request forwarded by a tunnel or proxy for a public client
   needs the code **and** approval on a paired device: the server answers
   `202 PairPendingResponse` (the code is spent), announces the request
   (`pair:requests` + an urgent push) and the new device polls
   `POST /api/pair/status {id, pollToken}` until a paired device decided via
   `POST /api/pair/requests/:id {approve}`. Requests expire after 5 min, at
   most 3 wait at once; all remote clients share 10 failed attempts / 10 min;
   while no device is paired, remote requests are refused (403).
3. Every `/api/*` route except `/api/health` requires `Authorization: Bearer`.
   socket.io handshake requires `auth.token`. `/api/pair` and
   `/api/pair/status` are public by nature. When a tunnel is enabled, pairing
   remains the only way in.
4. File downloads use **signed one-time tokens** because Android download
   managers cannot send headers:
   `GET /api/projects/:id/files/raw?path=...&token=<base64url(payload).sig>`,
   HMAC-SHA256 over `{projectId, path, exp}` with the JWT secret, TTL 120 s.
5. All file paths are resolved (`realpath`) and must stay inside
   `projectsRoot` — no traversal, no symlink escape. Uploads: images and
   regular files ≤ `maxUploadBytes`, sanitized filenames.
6. Agent processes run with cwd = project path, inherited env, are killed
   (SIGINT → 3 s grace → SIGKILL) on interrupt or `maxRunMs`.
7. `POST /api/bridge/run` is restricted to localhost callers holding the
   bridge token from `dataDir/bridge-token` (printed at startup).

## REST API (JSON; errors: `{"error":{"message":string,"code?:string}}`)

| Method | Path | Body → Result |
|---|---|---|
| GET | `/api/health` | `{ok,name,version,agents:[{id,available}],tunnel?:{status,publicUrl?}}` (no auth) |
| POST | `/api/pair` | `PairRequest → PairResponse`, or `202 PairPendingResponse` from outside the LAN |
| POST | `/api/pair/status` | `PairStatusRequest → PairStatusResponse` (no auth; the poll token is the credential; `approved` carries the `PairResponse` once) |
| GET / POST | `/api/pair/code` | `PairCodeResponse` (authed) — read the current pairing code / replace it with a new one |
| GET | `/api/pair/requests` | `PairRequestInfo[]` (authed) — remote pairing requests awaiting approval |
| POST | `/api/pair/requests/:id` | `{approve: boolean}` → 204 (authed) |
| GET | `/api/tunnel` | `TunnelInfo` (authed) |
| GET | `/api/server` | `ServerInfo` `{name,version,host}` (authed) — same object as `server` in the pairing response |
| GET | `/api/usage` | `AgentUsage[]` (authed, server-side cached 30 s; the app polls every minute while an agent is in use). Claude: parsed from `claude -p "/usage"`; Antigravity: `agy -p /usage` (5h/week + model quotas); Codex: rate-limit windows via the local app-server `account/rateLimits/read` RPC (login status fallback); OpenCode: `opencode stats`; ZCode: provider plan/model hint plus selectable plans. Reset times are shown in 24-hour format. |
| GET | `/api/update` | `UpdateInfo` `{current,latest?,updateAvailable,checkedAt?,checkError?,blockedReason?,job?}` (authed). `current` comes from `git describe` (`1.2.3`, or `1.2.3-4-gabc1234` past a release); `latest` is the newest GitHub release via `gh` (cached 10 min, `?refresh=1` asks again). |
| POST | `/api/update` | `→ UpdateInfo` (202). Runs `scripts/update.sh <tag>`: fast-forward to the release tag, build, restart. 409 `UPDATE_RUNNING` / `UPDATE_NOT_NEEDED` / `UPDATE_UNAVAILABLE`, 502 `UPDATE_CHECK_FAILED`. Progress streams via WS `update:state` `{update: UpdateInfo}`; a successful job ends with the server restarting. |
| GET | `/api/admin/jobs` | `AdminJob[]` (authed; newest first, kept in memory + capped) |
| POST | `/api/admin/jobs` | `StartAdminJobRequest → AdminJob` (202; 409 ADMIN_JOB_ACTIVE while one runs). Runs the agent's fixed recipe (see below) as a live job; after update/install the server re-detects the agent and broadcasts `agent:update`. Output streams via WS `admin:job`. |
| GET | `/api/admin/jobs/:id` | `AdminJob` |
| POST | `/api/admin/jobs/:id/stop` | `204` — cancels the ACTIVE job (status → `stopped`); 404 unknown, 409 `ADMIN_JOB_NOT_ACTIVE` |
| POST | `/api/admin/jobs/:id/input` | `AdminJobInputRequest` `{text}` or `{key}` → `204` — `text` types one line plus Enter into the ACTIVE interactive job (`AdminJob.interactive`, e.g. the sign-in code), `key` (`up` \| `down` \| `enter`) presses a single key (picking from a list); 404 unknown, 409 `ADMIN_JOB_NOT_ACTIVE` when it is not running or takes no input |

### Admin recipes (fixed, server-side — never free-form commands)

| Agent | update | install | login |
|---|---|---|---|
| claude | `claude update` | `npm install -g @anthropic-ai/claude-code` | `claude auth login` in a pseudo-terminal (interactive: the app shows the sign-in URL as a button and sends the pasted code via `/input`) |
| zcode | `scripts/update-zcode.sh` (builds from zai-org/ZCode → `~/.zcode/runtime`) | same script (clone-if-missing) | `zcode login zai` (browser on the machine; the app shows the fallback URL as a button) |
| antigravity | `flatpak update -y com.google.Antigravity` | `flatpak install -y flathub com.google.Antigravity` | opens the IDE window for Google sign-in (job finishes immediately) |
| codex | `codex update` | `npm install -g @openai/codex@latest` | `codex login --device-auth` (the app shows the sign-in page as a button and the one-time code to enter there) |
| opencode | `opencode upgrade` | `npm install -g opencode-ai` | `opencode providers login` in a pseudo-terminal (interactive: provider and method are picked with typed text and the `up`/`down`/`enter` keys, then an API key or a browser sign-in) |

Jobs run one-at-a-time globally (409 otherwise), each with a 30 min cap and a
500-line output ring buffer; the active job can be cancelled from the app
(status `stopped`). Commands are looked up on the server's PATH plus the user
bin dirs (`~/.local/bin`, `~/.npm-global/bin`, …) and the directory of the
server's own `node`. Interactive jobs run in a pseudo-terminal; their output is
reduced to plain text lines. After a successful Claude login — and on server
start when a sign-in is already stored — the server sets
`hasCompletedOnboarding` in Claude Code's config (`~/.claude.json`), otherwise
a new `claude` terminal would run the first-start setup and ask to sign in
again. `AgentInfo.admin` lists the per-agent actions.
| GET | `/api/agents` | `AgentInfo[]` |
| GET | `/api/devices` | `DeviceInfo[]` |
| DELETE | `/api/devices/:id` | `204` |
| GET | `/api/projects` | `Project[]` |
| POST | `/api/projects` | `CreateProjectRequest → Project` |
| POST | `/api/projects/clone` | `CloneProjectRequest → Project` (async clone; progress via `project:update`) |
| DELETE | `/api/projects/:id` | `204` (removes from registry, never deletes files) |
| GET | `/api/projects/:id/files` `?path=&all=` | `FileEntry[]` (`all=1` includes dotfiles) |
| GET | `/api/projects/:id/files/raw` `?path=&token=&download=` | file stream (inline for images/text, attachment otherwise; `download=1` always attachment) |
| GET | `/api/projects/:id/files/download-url` `?path=` | `FileDownloadUrlResponse` — signed `/files/raw` URL (`download=1`, TTL 120 s) for the system browser / download manager |
| GET | `/api/projects/:id/files/content` `?path=` | `FileContentResponse` — UTF-8 text read, cap 1 MB (`truncated:true`), 415 NON_TEXT for binary files (null byte or NFD check) |
| PUT | `/api/projects/:id/files/content` | `SaveFileRequest → SaveFileResponse` — atomic write (temp+rename), creates missing parent dirs, cap 1 MB, 415 NON_TEXT, 403 inside `.git/` |
| POST | `/api/projects/:id/files/create` | `CreateEntryRequest → 204` — new empty file or dir, 409 EXISTS, same sandbox rules |
| DELETE | `/api/projects/:id/files/entry` `?path=&recursive=0` | `204` — file always; dir only when empty (`recursive=1` for non-empty), 403 inside `.git/` |
| POST | `/api/projects/:id/files/upload` `?dir=`, `?sessionId=` or `?terminalId=` (multipart `file`) | `Attachment` — `terminalId` stores it for the agent in that terminal, outside the project, under a name without spaces, and adds `path` (absolute, on the server) for the app to type into the terminal; `sessionId` stores it as an attachment of that session (what the chat does), `dir` inside the project. `Attachment.url` is signed for 120 s; the app shows images through `/files/raw` with its device login instead |
| GET | `/api/sessions?projectId=` | `Session[]` |
| POST | `/api/sessions` | `CreateSessionRequest → Session` (now incl. optional `thinkingEffort`) |
| GET | `/api/sessions/:id` `?after=` | `SessionDetailResponse` `{session, messages, draft, partial?}` — `draft` (`SessionDraft`, else `null`) is what a run in progress has produced so far (`text`, `thinking`, `tools`, `usage`) plus `run`/`seq`; `after=<messageId>` returns only newer messages with `partial: true` (unknown id → whole history) |
| DELETE | `/api/sessions/:id` | `204` |
| POST | `/api/sessions/:id/messages` | `SendTurnRequest → SendTurnResponse` (409 if a run is active; `model`/`thinkingEffort` override the session defaults for that turn and update them) |
| POST | `/api/sessions/:id/interrupt` | `204` |
| POST | `/api/sessions/:id/permissions/:requestId` | body `{decision: allow\|always\|deny, message?, answers?}` → `204`; `409 PERMISSION_GONE` when the question is no longer open |
| POST | `/api/sessions/:id/ide` | opens/focuses the project in the agent IDE → `204` |
| GET | `/api/models/:agentId` | `{models: ModelPreset[]}` |
| GET | `/api/projects/:id/git/status` | `ProjectGitInfo` |
| POST | `/api/projects/:id/git/commit` | `GitCommitRequest → ProjectGitInfo` |
| POST | `/api/projects/:id/git/push` | `→ {ok, message}` |
| GET | `/api/github/repos` `?limit=&q=` | `GithubRepo[]` (via `gh`) |
| POST | `/api/team/runs` | `TeamRunRequest → TeamRun` |
| GET | `/api/team/runs?projectId=` | `TeamRun[]` |
| GET | `/api/team/runs/:id` | `TeamRun` |
| GET | `/api/stats` `?from=&to=&tzOffset=` | `StatsResponse` — sums of the recorded runs per agent, model, project, source and day (default: last 30 days; `tzOffset` = minutes ahead of UTC, decides where a day begins), plus subscription snapshots |
| GET | `/api/stats/runs` `?limit=&before=&agentId=&projectId=&routineId=` | `RunListResponse` — single runs, newest first |
| POST | `/api/bridge/run` | `{agent, prompt, project?, model?, timeoutMs?} → {ok, text?, error?, sessionId}` (bridge token, localhost only) |

Every mutating endpoint emits the matching WS update afterwards.

## WebSocket protocol (socket.io, path `/socket.io`)

JSON and text answers of the REST API are gzipped for clients that accept it
(file streams and downloads are not).

Typed in `packages/shared/src/events.ts`. `session:event` payloads of a run
carry `run` (id) and `seq` (counter from 1): a client that loaded a
`SessionDraft` skips the events with the same `run` and `seq <= draft.seq`,
so joining mid-run neither doubles nor loses text. Text and thinking deltas
are bundled server-side (40 ms) instead of one event per token.

Server pushes `session:event`,
`session:update`, `project:update`, `agent:update`, `team:update`,
`files:changed {projectId, events:[{type:'change'|'create'|'delete', path}]}`,
`notify`. Client emits `session:interrupt {sessionId}` with ack.

File watcher: every registered project gets a recursive `fs.watch` on its root
(started lazily on first access after boot, restarted on server start, dropped
on project delete). Events are debounced 400 ms, batched per project, paths
are project-relative, `.git/` internals are excluded. Writes through the API
also flow into the same `files:changed` stream so phones and agents stay in
sync in real time.

Team semantics: each step becomes a real `Session` (so history is browsable).
`sequence` + `passContext` prepends previous step results to each prompt.
`parallel` runs all steps at once. Status flows through `team:update`.

## MCP bridge (`agentdeck-mcp`)

Standalone stdio binary (`server` package `bin`). Hand-rolled JSON-RPC 2.0 MCP
server (no SDK dependency): `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`. Tools:

- `agentdeck_list_agents` → available agents + capabilities
- `agentdeck_delegate {agent, prompt, project?, model?, timeoutMs?}` → runs a
  turn via `POST /api/bridge/run` and returns the final assistant text
- `agentdeck_project_files {project?, path?}` → file listing

This is what makes cross-agent subagents work: register `agentdeck-mcp` as an
MCP server in Claude Code, ZCode or Antigravity and that agent can delegate
tasks to the other agents on the same machine.

## Frontend contract

The web app is served by the backend at `/` (built assets from `web/dist`,
SPA fallback for non-`/api` routes). Dev mode: Vite on :5173 with proxy for
`/api` + `/socket.io`. All types come from `@agentdeck/shared`.
UI language: English. Docs language: German.

**APK distribution / self-update (frontend):** the APK lives on the public
GitHub release — no server hosts it. The pairing screen and settings render an
"Android app" card from `GET https://api.github.com/repos/<repo>/releases/latest`
(the repo is injected at build time as `__RELEASE_REPO__`, default
`Ninjalama1337/agentdeck`) and link straight to the `app-debug.apk` asset. APK
builds inject their version via `VITE_AGENTDECK_APK_VERSION` (default
`0.0.0-web` for browser/PWA builds); when running inside Capacitor native
(`window.Capacitor?.isNativePlatform()`) and the installed version is older
than the release version, a dismissible update banner with a download button
appears. The PWA keeps updating itself via the service worker (already
implemented).

## BridgeMind ports (v0.9.0)

Features adopted from bridgemind.ai, mapped to a phone-first remote deck.

### Terminals ("Code" tab)

Real PTY shells on the server, one per open tab, project-scoped.

- `node-pty` (server-only dep, compiles on this machine) behind
  `server/src/term/manager.ts`.
- REST: `POST /api/terminals {projectId, cols?, rows?, timeZone?}` → `TerminalInfo`
  (`timeZone`: IANA zone of the device, set as `TZ` in the terminal);
  `GET /api/terminals?projectId=` → list; `DELETE /api/terminals/:id` → kill.
- WS client→server: `terminal:input {id, data}`, `terminal:resize {id, cols, rows}`.
- WS server→clients: `terminal:data {id, data}` (UTF-8 chunk),
  `terminal:exit {id, code}`, `terminal:list {terminals}` (create/kill).
- Constraints: cwd = project path, `$SHELL` (fallback `/bin/bash`), max 6
  concurrent terminals, idle timeout 15 min, all killed on server shutdown.
  Login flows for agent accounts happen here (e.g. `claude` with a custom
  `CLAUDE_CONFIG_DIR`).

### Routines (agents on recurring jobs)

- `Routine` = { id, name, projectId, agentId, prompt, model?, thinkingEffort?,
  accountId?, schedule, enabled, sessionId?, lastRunAt?, lastStatus? }.
- `schedule` = `{kind:'interval', minutes: 1..20160}` |
  `{kind:'daily', time:'HH:MM'}` | `{kind:'weekly', weekday:0-6, time:'HH:MM'}`
  (server local time).
- One persistent session per routine (created on first fire, titled
  `[routine] <name>`); every fire appends a `source:'routine'` user message
  and starts a normal turn. A fire is skipped while that session still has an
  active run.
- Scheduler tick: 30 s; `nextRunAt` is derived, never stored.
- REST: `GET/POST /api/routines`, `PATCH /api/routines/:id`,
  `DELETE /api/routines/:id`, `POST /api/routines/:id/run` (fire now).
- WS: `routine:update {routine}` on every change/fire.
- Event schedules: `{kind:'commit'}` fires when the project's HEAD moved,
  `{kind:'ci-failed'}` when the newest finished GitHub Actions run failed
  (`gh run list`, asked every 2 min), `{kind:'webhook'}` on
  `POST /api/hooks/routine/:id/:token` (no device login — the routine's
  `hookToken` in the URL is the key; `202`, body is appended to the prompt;
  30 calls/min per caller). The first look only remembers what is there
  (`triggerState`); what set a run off is appended to the prompt.
  `POST /api/routines/:id/hook-token` issues a new token.
- `freshContext: true` — every run starts a new agent conversation.
- `GET /api/routines/:id/runs?limit=&before=` → `RunListResponse` (history,
  from the activity database).

### Multi-accounts (usage limit becomes a choice)

- `Account` = { id, name, agentId, env: Record<string,string> }. Env keys must
  match `^[A-Z_][A-Z0-9_]*$` (≤ 24 entries); values are strings (≤ 500 chars).
  Typical keys: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. No secrets are stored by
  the server — logins happen in a Terminal.
- `Session.accountId?` selects the account; `AgentManager` merges
  `account.env` AFTER `plan.env` (account wins) into the spawn env.
- `CreateSessionRequest.accountId?` validated against existing accounts of
  that agent.
- REST: `GET/POST /api/accounts`, `DELETE /api/accounts/:id`.

### Enhance prompt

- `POST /api/enhance {projectId, agentId, text, model?, thinkingEffort?}` →
  `{text}`. Runs the agent headless with a fixed meta-prompt (rewrite the
  draft into a crisp brief), transient (no session/messages persisted),
  60 s cap. Uses the same adapters, never appears in history.

### Dashboard (Home tab)

Pure frontend aggregation over existing REST/WS streams: agent roster,
"Running now" (sessions with status running/queued across projects), routines
with next fire, projects. Tabs become Threads · Home · Code · Files · Settings
(GitHub moves into the Files header + project menu).
