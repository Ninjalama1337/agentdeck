/**
 * REST DTOs and domain models — shared between server and web app.
 */
import type { AgentId, PermissionMode } from './agents.js';

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'queued' | 'running' | 'error' | 'stopped';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** API-relative URL (served by the backend, authed via signed token query param). */
  url: string;
  kind: 'image' | 'file';
  /** Absolute path on the server — only for a terminal upload, whose agent is told where the file is. */
  path?: string;
}

export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens served from / written to the provider's cache — not part of `inputTokens`. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** One tool call of an assistant turn, kept with the message after the run. */
export interface ToolRecord {
  tool: string;
  ok: boolean;
  summary?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  agentId?: AgentId;
  model?: string;
  text: string;
  /** Model reasoning ("thinking"), kept strictly separate from the answer. */
  thinking?: string;
  /** Tool calls made during this turn, in order. */
  tools?: ToolRecord[];
  attachments: Attachment[];
  ts: number;
  usage?: MessageUsage;
  /** Where the turn came from. */
  source?: 'app' | 'mcp' | 'team' | 'routine';
}

export interface ProjectGitInfo {
  remote?: string;
  branch?: string;
  /** Number of dirty files. */
  dirty?: number;
  ahead?: number;
  behind?: number;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path on the remote machine (inside the project sandbox). */
  path: string;
  createdAt: number;
  updatedAt: number;
  git?: ProjectGitInfo;
}

export interface Session {
  id: string;
  projectId: string;
  agentId: AgentId;
  title: string;
  status: SessionStatus;
  model?: string;
  thinkingEffort?: string;
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  /** External conversation id for resume (e.g. Claude Code session id). */
  externalSessionId?: string;
  /** Agent account profile whose env overrides the adapter defaults. */
  accountId?: string;
  lastError?: string;
}

export type TeamStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface TeamStep {
  id: string;
  agentId: AgentId;
  prompt: string;
  /** Session created for this step (chat view is available per step). */
  sessionId?: string;
  status: TeamStepStatus;
  resultSummary?: string;
  error?: string;
}

export type TeamRunStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped';

export interface TeamRun {
  id: string;
  projectId: string;
  title: string;
  mode: 'sequence' | 'parallel';
  status: TeamRunStatus;
  steps: TeamStep[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// REST request / response DTOs
// ---------------------------------------------------------------------------

export interface PairRequest {
  code: string;
  deviceName: string;
}

/** Identity of a server as shown on paired devices (`GET /api/server`, pairing response). */
export interface ServerInfo {
  name: string;
  version: string;
  host: string;
}

export interface PairResponse {
  token: string;
  server: ServerInfo;
}

/**
 * Answer to `POST /api/pair` from outside the server's network: the code was
 * right, now a paired device has to approve. The new device shows `checkCode`
 * and polls `POST /api/pair/status` with `id` + `pollToken`.
 */
export interface PairPendingResponse {
  pending: { id: string; pollToken: string; checkCode: string; expiresAt: number };
}

export interface PairStatusRequest {
  id: string;
  pollToken: string;
}

/** `gone`: denied, expired or already collected — start over with a new code. */
export type PairStatusResponse = { status: 'pending' } | { status: 'gone' } | ({ status: 'approved' } & PairResponse);

/** A device outside the network waiting for approval, as paired devices see it. */
export interface PairRequestInfo {
  id: string;
  deviceName: string;
  ip: string;
  /** Same number the waiting device displays. */
  checkCode: string;
  createdAt: number;
  expiresAt: number;
}

/** Current pairing code, readable by paired devices (`GET /api/pair/code`). */
export interface PairCodeResponse {
  code: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  ext?: string;
  modifiedAt?: number;
}

/** One question the agent puts to the user, with the answers it offers. */
export interface PermissionQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/**
 * A run stopped to ask the user: may it make this tool call — or, with
 * `questions`, which of the offered answers applies. Answered from the chat.
 */
export interface PermissionRequest {
  id: string;
  tool: string;
  /** One-line gist of the call (command, file path). */
  summary?: string;
  /** The call in full as readable text (command, file content, diff), capped. */
  detail?: string;
  /** What an "always" answer would allow from now on; absent when the agent offers none. */
  always?: string;
  questions?: PermissionQuestion[];
  ts: number;
}

/** `always`: allow, and stop asking for this kind of call. */
export type PermissionDecision = 'allow' | 'always' | 'deny';

export interface AnswerPermissionRequest {
  decision: PermissionDecision;
  /** Deny: what the agent is told instead. */
  message?: string;
  /** Answers to `questions`, keyed by question text (several labels joined with ", "). */
  answers?: Record<string, string>;
}

/** What a run in progress has produced so far — lets a client that joins mid-run show the whole answer. */
export interface SessionDraft {
  /** Run id; with `seq` it tells which `session:event`s this snapshot already contains. */
  run: string;
  seq: number;
  text: string;
  thinking?: string;
  tools: { tool: string; state: 'running' | 'done' | 'error'; summary?: string }[];
  usage?: MessageUsage;
  /** Questions of this run still waiting for the user. Missing on older servers. */
  permissions?: PermissionRequest[];
}

export interface SessionDetailResponse {
  session: Session;
  messages: ChatMessage[];
  /** null = no run active. Missing on servers before 0.11.16. */
  draft?: SessionDraft | null;
  /** True when `messages` holds only those after the requested `after` id. */
  partial?: boolean;
}

export interface SendTurnRequest {
  text: string;
  attachmentIds?: string[];
  /** Override the session model for this turn. */
  model?: string;
  /** Override the thinking/reasoning effort for this turn. */
  thinkingEffort?: string;
}

export interface SendTurnResponse {
  userMessage: ChatMessage;
}

export interface CreateProjectRequest {
  name: string;
  initGit?: boolean;
}

export interface CloneProjectRequest {
  url: string;
  name?: string;
}

/**
 * Adopt a directory that already exists on the server machine as a project
 * (e.g. a repo checked out elsewhere). `path` must be inside the browse root.
 */
export interface OpenProjectRequest {
  path: string;
  name?: string;
}

/** One directory inside the server's browse root (folder picker). */
export interface BrowseEntry {
  name: string;
  /** Absolute path on the server. */
  path: string;
  /** True when the directory itself is a git working tree. */
  isGitRepo?: boolean;
}

/** Listing for the folder picker (`GET /api/fs/browse`). */
export interface BrowseResponse {
  /** Absolute path of the directory being listed. */
  path: string;
  /** Absolute path of the parent directory, when inside the root. */
  parent?: string;
  /** Absolute path of the browse root; navigation never goes above it. */
  root: string;
  entries: BrowseEntry[];
}

export interface CreateSessionRequest {
  projectId: string;
  agentId: AgentId;
  model?: string;
  thinkingEffort?: string;
  permissionMode?: PermissionMode;
  /** Account profile for this thread (env overrides; see Account). */
  accountId?: string;
  title?: string;
}

export interface UpdateSessionRequest {
  /** Applies from the session's next turn (each turn starts the CLI with `--permission-mode`). */
  permissionMode?: PermissionMode;
}

export interface TeamRunRequest {
  projectId: string;
  title?: string;
  mode: 'sequence' | 'parallel';
  /** Sequential mode: append previous step results to each prompt. */
  passContext?: boolean;
  steps: { agentId: AgentId; prompt: string }[];
}

export interface GithubRepo {
  nameWithOwner: string;
  url: string;
  description?: string | null;
  updatedAt?: string;
  isPrivate?: boolean;
  language?: string | null;
}

export interface GitCommitRequest {
  message: string;
  /** Stage all changes before committing (default true). */
  all?: boolean;
  /** Commit only these paths (overrides `all`). */
  files?: string[];
}

/** Short-lived signed URL (server-relative) that downloads one file without auth headers. */
export interface FileDownloadUrlResponse {
  url: string;
}

// ---------------------------------------------------------------------------
// In-app file editing
// ---------------------------------------------------------------------------

export interface FileContentResponse {
  path: string;
  content: string;
  size: number;
  mime: string;
  /** true when content exceeded the read cap and was truncated. */
  truncated: boolean;
}

export interface SaveFileRequest {
  path: string;
  content: string;
}

export interface SaveFileResponse {
  path: string;
  size: number;
  savedAt: number;
}

export interface CreateEntryRequest {
  path: string;
  kind: 'file' | 'dir';
}

export type FileChangeEventKind = 'change' | 'create' | 'delete';

export interface FileChangeEvent {
  type: FileChangeEventKind;
  /** Path relative to the project root. */
  path: string;
}

// ---------------------------------------------------------------------------
// Agent administration (update / install / login) — live jobs
// ---------------------------------------------------------------------------

export type AdminJobKind = 'update' | 'install' | 'login';

export type AdminJobStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped';

/** What the server can do for an agent (derived from static recipes). */
export interface AdminCapability {
  kind: AdminJobKind;
  /** Recipe headline shown in the UI ("claude update", "npm i -g …"). */
  label: string;
  /** Why the action is unavailable (login inside IDE etc.). */
  unavailableReason?: string;
}

export interface AdminJob {
  id: string;
  agentId: AgentId;
  kind: AdminJobKind;
  status: AdminJobStatus;
  /** Rolling console output (capped server-side). */
  output: string[];
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
  /** Runs in a pseudo-terminal and takes input (sign-in code) via `/input`. */
  interactive?: boolean;
}

export interface StartAdminJobRequest {
  agentId: AgentId;
  kind: AdminJobKind;
}

/** A key pressed in an interactive admin job (picking from a list it shows). */
export type AdminJobKey = 'up' | 'down' | 'enter';

/**
 * Input for an interactive admin job: one typed line (the pasted sign-in
 * code), or a single key.
 */
export type AdminJobInputRequest = { text: string } | { key: AdminJobKey };

// ---------------------------------------------------------------------------
// Server self-update (GitHub releases)
// ---------------------------------------------------------------------------

export type UpdateJobStatus = 'running' | 'done' | 'error';

/** One run of scripts/update.sh, streamed via WS `update:state`. */
export interface UpdateJob {
  /** Release version being installed, e.g. `1.2.3`. */
  target: string;
  status: UpdateJobStatus;
  /** Rolling console output (capped server-side). */
  output: string[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface UpdateInfo {
  /** Version this server runs: `1.2.3` (a release) or `1.2.3-4-gabc1234` (commits past one). */
  current: string;
  /** Latest GitHub release; absent when the repo has none or the check failed. */
  latest?: { version: string; tag: string; url?: string; publishedAt?: string; notes?: string };
  updateAvailable: boolean;
  /** When GitHub was last asked (ms epoch). */
  checkedAt?: number;
  /** Why the release check failed (gh missing / not logged in / offline). */
  checkError?: string;
  /** Why this server cannot update itself (e.g. not a git checkout). */
  blockedReason?: string;
  /** The running or last update of this server process. */
  job?: UpdateJob;
}

// ---------------------------------------------------------------------------
// Remote access (tunnel)
// ---------------------------------------------------------------------------

export type TunnelProvider = 'cloudflared' | 'off';
export type TunnelStatus = 'disabled' | 'starting' | 'connected' | 'error';

export interface TunnelInfo {
  provider: TunnelProvider;
  status: TunnelStatus;
  /** Public HTTPS URL (e.g. https://xxx.trycloudflare.com) once connected. */
  publicUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Thinking effort + subscription usage
// ---------------------------------------------------------------------------

/** Reasoning effort per session/turn. Adapters map to CLI flags; agents list
 *  their supported levels in AgentInfo.efforts. */
export type ThinkingEffort = 'default' | 'adaptive' | 'low' | 'medium' | 'high';

export interface UsageWindow {
  pct?: number;
  resetsAt?: string;
  requests?: number;
  sessions?: number;
}

export interface AgentPlanOption {
  id: string;
  label: string;
  active: boolean;
  status?: string;
  detail?: string;
  resetsAt?: string;
  tokens?: number;
  models?: string[];
  session?: UsageWindow;
  week?: UsageWindow;
}

export interface AgentUsage {
  agentId: AgentId;
  available: boolean;
  reason?: string;
  plan?: string;
  session?: UsageWindow;
  week?: UsageWindow;
  /** Provider-specific subscription rate-limit windows (e.g. Codex). */
  rateLimits?: { name: string; window: UsageWindow }[];
  /** Antigravity quota breakdown by model family. */
  modelsQuota?: { name: string; sessionLimit?: UsageWindow; weeklyLimit?: UsageWindow }[];
  last24h?: UsageWindow;
  last7d?: UsageWindow;
  /** Dollar cost (e.g. from OpenCode stats). */
  cost?: string;
  /** Token breakdown (e.g. from OpenCode stats). */
  tokens?: { input?: string; output?: string; cache?: string };
  /** Active plan id when multiple plans/modes exist (e.g. 'subscription' vs 'free'). */
  activePlanId?: string;
  /** Available plan choices (e.g. ZCode subscription vs free tokens). */
  plans?: AgentPlanOption[];
  /** Unparsed CLI output for transparency / debugging. */
  raw?: string;
  fetchedAt: number;
}

export interface ApiError {
  error: { message: string; code?: string };
}

// ---------------------------------------------------------------------------
// Activity — every agent run on record (server database): who did how much
// ---------------------------------------------------------------------------

/** Where a run came from; `terminal` is a turn of an agent TUI in the Code tab. */
export type RunSource = 'app' | 'mcp' | 'team' | 'routine' | 'terminal';

export type RunOutcome = 'ok' | 'error' | 'stopped';

/** One finished agent run. */
export interface RunRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  /** An AgentId, or the launcher preset of a terminal. */
  agentId: string;
  model?: string;
  projectId?: string;
  projectName?: string;
  sessionId?: string;
  terminalId?: string;
  routineId?: string;
  source: RunSource;
  status: RunOutcome;
  error?: string;
  /** What was asked, shortened. */
  title?: string;
  /** How the answer began, shortened. */
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** As the CLI reports it — for a subscription the price the same work costs over the API. */
  costUsd?: number;
  toolCalls?: number;
}

/** Sums over a set of runs. */
export interface StatsBucket {
  runs: number;
  ok: number;
  errors: number;
  stopped: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  toolCalls: number;
}

/** A subscription's limits at one moment (kept whenever usage is read). */
export interface PlanSnapshot {
  agentId: string;
  ts: number;
  plan?: string;
  sessionPct?: number;
  weekPct?: number;
  sessionResetsAt?: string;
  weekResetsAt?: string;
}

export interface StatsResponse {
  /** False when the server cannot keep the database (Node without SQLite). */
  available: boolean;
  reason?: string;
  from: number;
  to: number;
  totals: StatsBucket;
  byAgent: (StatsBucket & { agentId: string })[];
  byModel: (StatsBucket & { agentId: string; model: string })[];
  byProject: (StatsBucket & { projectId: string; projectName: string })[];
  bySource: (StatsBucket & { source: RunSource })[];
  /** Per calendar day in the caller's timezone (`YYYY-MM-DD`) and agent. */
  byDay: (StatsBucket & { day: string; agentId: string })[];
  /** Latest subscription state per agent. */
  plans: PlanSnapshot[];
  /** Subscription use over the range, thinned to one point per agent and hour. */
  planHistory: PlanSnapshot[];
  /** Start of the oldest run on record — how far back the data reaches. */
  firstRunAt?: number;
}

export interface RunListResponse {
  runs: RunRecord[];
  /** Pass as `before` to load older runs; absent at the end. */
  next?: number;
}

// ---------------------------------------------------------------------------
// Terminals ("Code" tab) — real PTY shells on the server
// ---------------------------------------------------------------------------

export interface TerminalInfo {
  id: string;
  projectId: string;
  createdAt: number;
  cols: number;
  rows: number;
  /** Process exit code once the shell ended (event only, not in list). */
  exitCode?: number;
  /** Human title ("Claude Code", "shell", custom command). */
  title?: string;
  /** Launcher preset the terminal was started from (see TerminalPreset). */
  presetId?: string;
  /** Preset variant (new, continue, yolo, …). */
  variantId?: string;
  /** Command typed into the shell right after spawn (agent TUI etc.). */
  command?: string;
  /** Last PTY output timestamp. */
  lastOutputAt?: number;
  /** The terminal rang / went quiet after work and waits for the user. */
  attention?: boolean;
  /** Why it wants the user — set together with `attention`. */
  attentionState?: DeckNotificationState;
  /** Whether the terminal session is persistent across server restarts (tmux-backed). */
  persistent?: boolean;
}

export interface CreateTerminalRequest {
  projectId: string;
  cols?: number;
  rows?: number;
  /** Launcher preset id (claude, codex, opencode, …); omitted = plain shell. */
  presetId?: string;
  /** Variant of the preset (new, continue, yolo, …). */
  variantId?: string;
  /** Free-form command typed into the shell after spawn (overrides preset). */
  command?: string;
  title?: string;
  /** IANA zone of the device ("Europe/Berlin") — clock times in the terminal follow it, not the server's zone. */
  timeZone?: string;
}

export interface TerminalPresetVariant {
  id: string;
  label: string;
  /** Extra CLI args appended to the preset command. */
  args: string;
  hint?: string;
  danger?: boolean;
}

/** One-tap launcher for an agent TUI (or tool) inside a PTY. */
export interface TerminalPreset {
  id: string;
  label: string;
  description: string;
  kind: 'agent' | 'tool' | 'shell';
  /** Base command; empty for the plain shell. */
  command: string;
  accent: string;
  /** Binary found on the server PATH (always true for the shell). */
  available: boolean;
  /** Resolved absolute path of the binary, when found. */
  resolvedPath?: string;
  variants: TerminalPresetVariant[];
  /** Quick-send snippets shown as chips while this preset runs. */
  snippets?: { label: string; text: string }[];
  /** Install hint shown when unavailable. */
  install?: string;
}

// ---------------------------------------------------------------------------
// Notifications — in-app inbox + Web Push
// ---------------------------------------------------------------------------

export type DeckNotificationKind =
  | 'session-done'
  | 'session-error'
  | 'session-permission'
  | 'terminal-attention'
  | 'team-done'
  | 'team-error'
  | 'info';

/**
 * What happened, from the user's point of view:
 * `done` — the agent finished · `waiting` — it stopped to ask something ·
 * `limit` — its usage limit / quota is used up · `error` — the run failed.
 */
export type DeckNotificationState = 'done' | 'waiting' | 'limit' | 'error';

export interface DeckNotification {
  id: string;
  kind: DeckNotificationKind;
  /** Absent on servers that predate it and on `info` notifications. */
  state?: DeckNotificationState;
  title: string;
  body: string;
  ts: number;
  projectId?: string;
  sessionId?: string;
  terminalId?: string;
  runId?: string;
  /** Terminal waiting on a yes/no question the notification can answer. */
  prompt?: 'menu' | 'yesno';
  /** Session waiting on this permission request — the notification can allow or deny it. */
  permissionId?: string;
}

export interface PushStatus {
  /** Server can send Web Push (VAPID keys ready). */
  enabled: boolean;
  publicKey?: string;
  /** Number of subscriptions registered for the calling device. */
  subscriptions: number;
  /** Server can send FCM (APK push that survives Doze); absent on older servers. */
  fcm?: boolean;
  /** FCM tokens registered for the calling device. */
  fcmTokens?: number;
}

/** No push in this window; `from`/`to` are minutes since local midnight, `tzOffset` minutes east of UTC. */
export interface QuietHours {
  from: number;
  to: number;
  tzOffset: number;
}

export interface FcmRegisterRequest {
  token: string;
  quiet?: QuietHours;
  /** Which notification kinds this device wants pushed (default: all). */
  kinds?: DeckNotificationKind[];
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Which notification kinds this device wants pushed (default: all). */
  kinds?: DeckNotificationKind[];
  quiet?: QuietHours;
}

// ---------------------------------------------------------------------------
// Voice — server-side transcription for dictation
// ---------------------------------------------------------------------------

export interface VoiceStatus {
  available: boolean;
  provider?: 'openai' | 'groq' | 'command';
  reason?: string;
}

export interface TranscribeResponse {
  text: string;
}

// ---------------------------------------------------------------------------
// Git (extended) — changes, diff, log, branches
// ---------------------------------------------------------------------------

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'copied' | 'typechange';

export interface GitChange {
  path: string;
  /** Previous path for renames. */
  from?: string;
  state: GitFileState;
  staged: boolean;
  unstaged: boolean;
}

export interface GitCommitInfo {
  hash: string;
  short: string;
  subject: string;
  author: string;
  ts: number;
  refs?: string;
}

export interface GitBranches {
  current?: string;
  local: string[];
  remote: string[];
}

export interface GitDiffResponse {
  diff: string;
  truncated: boolean;
  binary?: boolean;
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Routines — agents on recurring jobs
// ---------------------------------------------------------------------------

/**
 * When a routine fires: on a clock (`interval`, `daily`, `weekly`) or on an
 * event — `commit`: the project's checked-out HEAD moved (a commit, a pull);
 * `ci-failed`: the newest finished GitHub Actions run of the project failed;
 * `webhook`: something called the routine's hook URL.
 */
export type RoutineSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'commit' }
  | { kind: 'ci-failed' }
  | { kind: 'webhook' };

/** What set a routine off. */
export type RoutineTrigger = 'schedule' | 'manual' | 'commit' | 'ci-failed' | 'webhook';

export interface Routine {
  id: string;
  name: string;
  projectId: string;
  agentId: AgentId;
  prompt: string;
  model?: string;
  thinkingEffort?: string;
  accountId?: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  /** Every run starts without the earlier runs' conversation (their chat stays readable). */
  freshContext?: boolean;
  /** `webhook` routines: the secret that is part of the hook URL (`/api/hooks/routine/<id>/<token>`). */
  hookToken?: string;
  /** Event routines: what was last seen (commit hash, CI run id) — a change fires. */
  triggerState?: string;
  /** Session used for every fire (created on the first run). */
  sessionId?: string;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  createdAt: number;
  updatedAt: number;
}

export interface CreateRoutineRequest {
  name: string;
  projectId: string;
  agentId: AgentId;
  prompt: string;
  model?: string;
  thinkingEffort?: string;
  accountId?: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
  freshContext?: boolean;
}

export type UpdateRoutineRequest = Partial<CreateRoutineRequest>;

// ---------------------------------------------------------------------------
// Accounts — env profiles per agent (multi-account usage switching)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  agentId: AgentId;
  /** Env vars merged into every run of sessions using this account. */
  env: Record<string, string>;
  createdAt: number;
}

export interface CreateAccountRequest {
  name: string;
  agentId: AgentId;
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Enhance — rewrite a rough draft into a crisp prompt (transient, no session)
// ---------------------------------------------------------------------------

export interface EnhanceRequest {
  projectId: string;
  agentId: AgentId;
  text: string;
  model?: string;
  thinkingEffort?: string;
}

export interface EnhanceResponse {
  text: string;
}
