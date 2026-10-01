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
}

export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
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
  /** Absolute path on the remote machine (sandboxed to projectsRoot). */
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

export interface PairResponse {
  token: string;
  server: { name: string; version: string; host: string };
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
}

export interface StartAdminJobRequest {
  agentId: AgentId;
  kind: AdminJobKind;
}

// ---------------------------------------------------------------------------
// Remote access (tunnel) + APK distribution
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

export interface ApkInfo {
  available: boolean;
  version?: string;
  size?: number;
  sha256?: string;
  builtAt?: number;
  channel?: string;
  fileName?: string;
}

export interface ApkUploadResponse extends ApkInfo {
  message: string;
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

export interface AgentUsage {
  agentId: AgentId;
  available: boolean;
  reason?: string;
  plan?: string;
  session?: UsageWindow;
  week?: UsageWindow;
  last24h?: UsageWindow;
  last7d?: UsageWindow;
  /** Provider quota windows (e.g. Codex 5-hour, weekly, or monthly limits). */
  rateLimits?: { name: string; window: UsageWindow }[];
  /** Dollar cost (e.g. from OpenCode stats). */
  cost?: string;
  /** Token breakdown (e.g. from OpenCode stats). */
  tokens?: { input?: string; output?: string; cache?: string };
  /** Multi-model breakdown (e.g. from Antigravity/AGY quota). */
  modelsQuota?: { name: string; sessionLimit?: UsageWindow; weeklyLimit?: UsageWindow }[];
  /** Unparsed CLI output for transparency / debugging. */
  raw?: string;
  fetchedAt: number;
}

export interface ApiError {
  error: { message: string; code?: string };
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
  | 'terminal-attention'
  | 'team-done'
  | 'team-error'
  | 'info';

export interface DeckNotification {
  id: string;
  kind: DeckNotificationKind;
  title: string;
  body: string;
  ts: number;
  projectId?: string;
  sessionId?: string;
  terminalId?: string;
  runId?: string;
}

export interface PushStatus {
  /** Server can send Web Push (VAPID keys ready). */
  enabled: boolean;
  publicKey?: string;
  /** Number of subscriptions registered for the calling device. */
  subscriptions: number;
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Which notification kinds this device wants pushed (default: all). */
  kinds?: DeckNotificationKind[];
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

export type RoutineSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string };

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
