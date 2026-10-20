/**
 * Typed fetch wrapper for the AgentDeck REST API.
 * All request/response types come from @agentdeck/shared (see docs/CONTRACT.md).
 */
import type {
  Account,
  AgentId,
  AdminJob,
  AdminJobKey,
  AnswerPermissionRequest,
  AgentInfo,
  AgentUsage,
  Attachment,
  BrowseResponse,
  CloneProjectRequest,
  CreateAccountRequest,
  CreateEntryRequest,
  FileInfoResponse,
  RenameEntryRequest,
  RenameEntryResponse,
  CreateProjectRequest,
  CreateRoutineRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  CreateTerminalRequest,
  DeckNotification,
  DeviceInfo,
  GitBranches,
  GitChange,
  GitCommitInfo,
  DailySummary,
  DigestSettings,
  GitDiffResponse,
  GithubItem,
  GithubItemDetail,
  ParallelLaunchRequest,
  PortInfo,
  PowerStatus,
  PreviewLinkResponse,
  ResourcesResponse,
  ParallelLaunchResponse,
  WorktreeInfo,
  GitOpResult,
  FcmRegisterRequest,
  PushStatus,
  PushSubscribeRequest,
  TerminalPreset,
  VoiceStatus,
  EnhanceRequest,
  EnhanceResponse,
  FileContentResponse,
  FileDownloadUrlResponse,
  FileEntry,
  GithubRepo,
  GitCommitRequest,
  ModelPreset,
  OpenProjectRequest,
  PairCodeResponse,
  PairPendingResponse,
  PairRequest,
  PairRequestInfo,
  PairResponse,
  PairStatusRequest,
  PairStatusResponse,
  Project,
  ProjectGitInfo,
  RunListResponse,
  StatsResponse,
  Routine,
  SaveFileRequest,
  SaveFileResponse,
  SendTurnRequest,
  SendTurnResponse,
  Session,
  SessionDetailResponse,
  StartAdminJobRequest,
  ServerInfo,
  TeamRun,
  TeamRunRequest,
  TerminalInfo,
  TunnelInfo,
  TunnelStatus,
  UpdateInfo,
  UpdateRoutineRequest,
} from '@agentdeck/shared';
import { getActiveServer, updateActiveServer } from './servers';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ------------------------------------------------------------------ config */

/** Login and address of the active saved server (see servers.ts). */
export function getToken(): string | null {
  return getActiveServer().token;
}

export function setToken(token: string | null): void {
  updateActiveServer({ token });
}

/** '' means same-origin (backend serves the app). */
export function getApiBase(): string {
  return getActiveServer().base;
}

export function setApiBase(base: string): void {
  updateActiveServer({ base });
}

function base(): string {
  return getApiBase();
}

export function unauthorizedEventName(): string {
  return 'agentdeck:unauthorized';
}

function emitUnauthorized(): void {
  window.dispatchEvent(new CustomEvent(unauthorizedEventName()));
}

/* ------------------------------------------------------------------ helper */

type Query = Record<string, string | number | undefined>;

function qs(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    if (data?.error?.message) return data.error.message;
  } catch {
    /* not json */
  }
  return `Request failed (HTTP ${res.status})`;
}

interface RequestOptions {
  json?: unknown;
  query?: Query;
  /** Skip the Authorization header (pairing, health). */
  noAuth?: boolean;
}

/**
 * Parse a JSON response; when the body is a web page (e.g. the Capacitor
 * asset server or some other site answered), throw a helpful error instead
 * of the cryptic "Unexpected token '<'".
 */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  if (text.trimStart().startsWith('<') || (type !== '' && !type.includes('json'))) {
    throw new ApiError(
      'This address served a web page, not the AgentDeck API. In the Android app, open "Use a different server address" and enter your server URL (LAN IP or tunnel address).',
      0,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('Invalid server response (not JSON)', 0);
  }
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token && !opts.noAuth) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(base() + path + qs(opts.query), { method, headers, body });
  } catch {
    throw new ApiError('Cannot reach the AgentDeck server', 0);
  }
  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError('Unauthorized — pair again', 401);
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  if (res.status === 204) return undefined as T;
  return readJson<T>(res);
}

/* -------------------------------------------------------------------- api */

export const api = {
  /** No auth required. Tunnel block mirrors GET /api/tunnel (public subset). */
  health(): Promise<{
    ok: boolean;
    name: string;
    version: string;
    agents: { id: string; available: boolean }[];
    tunnel?: { status: TunnelStatus; publicUrl?: string };
  }> {
    return request('GET', '/api/health', { noAuth: true });
  },

  /** A token from the server's network; from outside, a request a paired device has to approve. */
  pair(body: PairRequest): Promise<PairResponse | PairPendingResponse> {
    return request('POST', '/api/pair', { json: body, noAuth: true });
  },

  pairStatus(body: PairStatusRequest): Promise<PairStatusResponse> {
    return request('POST', '/api/pair/status', { json: body, noAuth: true });
  },

  /** Current pairing code, to pair another device from this one. */
  pairCode(): Promise<PairCodeResponse> {
    return request('GET', '/api/pair/code');
  },

  newPairCode(): Promise<PairCodeResponse> {
    return request('POST', '/api/pair/code');
  },

  pairRequests(): Promise<PairRequestInfo[]> {
    return request('GET', '/api/pair/requests');
  },

  decidePairRequest(id: string, approve: boolean): Promise<void> {
    return request('POST', `/api/pair/requests/${encodeURIComponent(id)}`, { json: { approve } });
  },

  /** Name/version of the paired server (404 on servers older than this route). */
  server(): Promise<ServerInfo> {
    return request('GET', '/api/server');
  },

  /** Public remote-access tunnel status (bearer sent when a token exists). */
  tunnel(): Promise<TunnelInfo> {
    return request('GET', '/api/tunnel');
  },

  /** Server version + latest GitHub release (`refresh` asks GitHub again). */
  update(refresh = false): Promise<UpdateInfo> {
    return request('GET', '/api/update', refresh ? { query: { refresh: 1 } } : {});
  },

  /** Update the server to the latest release (202). 409 when running / nothing to do. */
  startUpdate(): Promise<UpdateInfo> {
    return request('POST', '/api/update');
  },

  /** Subscription usage per agent (claude plan limits, codex login, ...). */
  getUsage(): Promise<AgentUsage[]> {
    return request('GET', '/api/usage');
  },

  /** Switch active plan / quota mode for an agent (e.g. ZCode subscription vs free tokens). */
  switchPlan(agentId: string, planId: string): Promise<{ ok: boolean; activePlanId: string }> {
    return request('POST', `/api/agents/${encodeURIComponent(agentId)}/plan`, { json: { planId } });
  },

  agents(): Promise<AgentInfo[]> {
    return request('GET', '/api/agents');
  },

  devices(): Promise<DeviceInfo[]> {
    return request('GET', '/api/devices');
  },

  deleteDevice(id: string): Promise<void> {
    return request('DELETE', `/api/devices/${encodeURIComponent(id)}`);
  },

  projects(): Promise<Project[]> {
    return request('GET', '/api/projects');
  },

  createProject(body: CreateProjectRequest): Promise<Project> {
    return request('POST', '/api/projects', { json: body });
  },

  cloneProject(body: CloneProjectRequest): Promise<Project> {
    return request('POST', '/api/projects/clone', { json: body });
  },

  /** Register an existing directory on the server as a project. */
  openProject(body: OpenProjectRequest): Promise<Project> {
    return request('POST', '/api/projects/open', { json: body });
  },

  /** Folder picker: list directories under `path` (defaults to the browse root). */
  browseFs(path?: string, all?: boolean): Promise<BrowseResponse> {
    return request('GET', '/api/fs/browse', {
      query: { path, all: all ? 1 : undefined },
    });
  },

  deleteProject(id: string): Promise<void> {
    return request('DELETE', `/api/projects/${encodeURIComponent(id)}`);
  },

  githubItems(projectId: string): Promise<GithubItem[]> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/github/items`);
  },

  githubItem(projectId: string, kind: 'issue' | 'pr', number: number): Promise<GithubItemDetail> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/github/${kind}/${number}`);
  },

  ports(): Promise<PortInfo[]> {
    return request('GET', '/api/ports');
  },

  previewLink(port: number, design = false): Promise<PreviewLinkResponse> {
    return request('POST', `/api/ports/${port}/preview`, design ? { json: { design: true } } : {});
  },

  resources(): Promise<ResourcesResponse> {
    return request('GET', '/api/terminals/resources');
  },

  /** Another agent continues this terminal's task (usage limit hand-over). */
  handover(
    terminalId: string,
    body: { presetId: string; accountId?: string; cols?: number; rows?: number; timeZone?: string },
  ): Promise<{ terminal: TerminalInfo }> {
    return request('POST', `/api/terminals/${encodeURIComponent(terminalId)}/handover`, { json: body });
  },

  killProcess(terminalId: string, pid: number): Promise<void> {
    return request('POST', `/api/terminals/${encodeURIComponent(terminalId)}/processes/${pid}/kill`);
  },

  digestToday(): Promise<DailySummary> {
    return request('GET', '/api/digest/today', { query: { tzOffset: -new Date().getTimezoneOffset() } });
  },

  digest(): Promise<DigestSettings> {
    return request('GET', '/api/digest');
  },

  setDigest(body: Partial<Pick<DigestSettings, 'enabled' | 'time'>>): Promise<DigestSettings> {
    return request('PUT', '/api/digest', { json: body });
  },

  power(): Promise<PowerStatus> {
    return request('GET', '/api/power');
  },

  setPower(keepAwake: boolean): Promise<PowerStatus> {
    return request('PUT', '/api/power', { json: { keepAwake } });
  },

  /** One prompt, several agents, each in its own git worktree. */
  startParallel(body: ParallelLaunchRequest): Promise<ParallelLaunchResponse> {
    const { projectId, ...rest } = body;
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/parallel`, { json: rest });
  },

  worktrees(projectId: string): Promise<WorktreeInfo[]> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/worktrees`);
  },

  worktreeDiff(projectId: string, name: string): Promise<GitDiffResponse> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(name)}/diff`);
  },

  applyWorktree(projectId: string, name: string): Promise<{ merged: string }> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(name)}/apply`);
  },

  removeWorktree(projectId: string, name: string): Promise<void> {
    return request('DELETE', `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(name)}`);
  },

  /** Every file path of a project (quick open). */
  fileIndex(projectId: string): Promise<{ paths: string[]; truncated: boolean }> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/files/index`);
  },

  files(projectId: string, path?: string, all?: boolean): Promise<FileEntry[]> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/files`, {
      query: { path, all: all ? 1 : undefined },
    });
  },

  /** Authed URL for raw file access (Bearer header). Signed URLs come from Attachment.url. */
  fileRawPath(projectId: string, path: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(path)}`;
  },

  /** Absolute, signed (header-free) download URL — short-lived, for handing to the system browser. */
  async fileDownloadUrl(projectId: string, path: string): Promise<string> {
    const res = await request<FileDownloadUrlResponse>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/files/download-url`,
      { query: { path } },
    );
    return base() + res.url;
  },

  /** Read a UTF-8 text file (cap 1 MB → truncated:true; 415 NON_TEXT for binaries). */
  getFileContent(projectId: string, path: string): Promise<FileContentResponse> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/files/content`, {
      query: { path },
    });
  },

  /** Atomic text write (PUT). Creates missing parent dirs, cap 1 MB. */
  saveFileContent(projectId: string, path: string, content: string): Promise<SaveFileResponse> {
    const body: SaveFileRequest = { path, content };
    return request('PUT', `/api/projects/${encodeURIComponent(projectId)}/files/content`, { json: body });
  },

  /** Create an empty file or directory (409 EXISTS, sandbox rules apply). */
  createEntry(projectId: string, path: string, kind: CreateEntryRequest['kind']): Promise<void> {
    const body: CreateEntryRequest = { path, kind };
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/files/create`, { json: body });
  },

  /** Rename or move an entry (409 EXISTS when `to` is taken). */
  renameEntry(projectId: string, from: string, to: string): Promise<RenameEntryResponse> {
    const body: RenameEntryRequest = { from, to };
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/files/rename`, { json: body });
  },

  /** Size, dates, permissions … of one file or folder. */
  fileInfo(projectId: string, path: string): Promise<FileInfoResponse> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/files/info`, { query: { path } });
  },

  /** Delete a file (always) or a directory (non-empty only with recursive). */
  deleteEntry(projectId: string, path: string, recursive = false): Promise<void> {
    return request('DELETE', `/api/projects/${encodeURIComponent(projectId)}/files/entry`, {
      query: { path, recursive: recursive ? 1 : undefined },
    });
  },

  sessions(projectId?: string): Promise<Session[]> {
    return request('GET', '/api/sessions', { query: { projectId } });
  },

  /** `after`: only the messages newer than this id (`partial: true`) — older servers send the full history. */
  session(id: string, after?: string): Promise<SessionDetailResponse> {
    return request('GET', `/api/sessions/${encodeURIComponent(id)}`, { query: { after } });
  },

  createSession(body: CreateSessionRequest): Promise<Session> {
    return request('POST', '/api/sessions', { json: body });
  },

  updateSession(id: string, body: UpdateSessionRequest): Promise<Session> {
    return request('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { json: body });
  },

  deleteSession(id: string): Promise<void> {
    return request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  },

  sendTurn(sessionId: string, body: SendTurnRequest): Promise<SendTurnResponse> {
    return request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { json: body });
  },

  interrupt(sessionId: string): Promise<void> {
    return request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`);
  },

  /** What the agents did between `from` and `to`; days follow the device's timezone. */
  stats(query: { from?: number; to?: number }): Promise<StatsResponse> {
    return request('GET', '/api/stats', { query: { ...query, tzOffset: -new Date().getTimezoneOffset() } });
  },

  statsRuns(query: { limit?: number; before?: number; agentId?: string; projectId?: string; routineId?: string }): Promise<RunListResponse> {
    return request('GET', '/api/stats/runs', { query });
  },

  answerPermission(sessionId: string, requestId: string, body: AnswerPermissionRequest): Promise<void> {
    return request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      { json: body },
    );
  },

  openInIde(sessionId: string): Promise<void> {
    return request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/ide`);
  },

  models(agentId: string, projectPath?: string): Promise<{ models: ModelPreset[]; defaultModel?: ModelPreset }> {
    const query = projectPath ? `?path=${encodeURIComponent(projectPath)}` : '';
    return request('GET', `/api/models/${encodeURIComponent(agentId)}${query}`);
  },

  gitStatus(projectId: string): Promise<ProjectGitInfo> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/status`);
  },

  gitCommit(projectId: string, body: GitCommitRequest): Promise<ProjectGitInfo> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/commit`, { json: body });
  },

  gitPush(projectId: string): Promise<{ ok: boolean; message?: string }> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/push`);
  },

  githubRepos(q?: string, limit?: number): Promise<GithubRepo[]> {
    return request('GET', '/api/github/repos', { query: { q, limit } });
  },

  teamRuns(projectId?: string): Promise<TeamRun[]> {
    return request('GET', '/api/team/runs', { query: { projectId } });
  },

  teamRun(id: string): Promise<TeamRun> {
    return request('GET', `/api/team/runs/${encodeURIComponent(id)}`);
  },

  createTeamRun(body: TeamRunRequest): Promise<TeamRun> {
    return request('POST', '/api/team/runs', { json: body });
  },

  /** All agent admin jobs (update/install/login), newest first. */
  adminJobs(): Promise<AdminJob[]> {
    return request('GET', '/api/admin/jobs');
  },

  /** Kick off an admin job (202). 409 ADMIN_JOB_ACTIVE while one job runs. */
  startAdminJob(body: StartAdminJobRequest): Promise<AdminJob> {
    return request('POST', '/api/admin/jobs', { json: body });
  },

  /** Cancels the running admin job (204; 409 when not active). */
  stopAdminJob(id: string): Promise<void> {
    return request('POST', `/api/admin/jobs/${encodeURIComponent(id)}/stop`);
  },

  /** Types one line (the sign-in code) into the running interactive job. */
  sendAdminJobInput(id: string, text: string): Promise<void> {
    return request('POST', `/api/admin/jobs/${encodeURIComponent(id)}/input`, { json: { text } });
  },

  /** Presses one key in the running interactive job (picking from a list). */
  sendAdminJobKey(id: string, key: AdminJobKey): Promise<void> {
    return request('POST', `/api/admin/jobs/${encodeURIComponent(id)}/input`, { json: { key } });
  },

  /** Single admin job with its current output ring buffer. */
  adminJob(id: string): Promise<AdminJob> {
    return request('GET', `/api/admin/jobs/${encodeURIComponent(id)}`);
  },

  /* ------------------------------------------------ BridgeMind ports (0.9) */

  /** PTY terminals ("Code" tab). */
  terminals(projectId?: string): Promise<TerminalInfo[]> {
    return request('GET', '/api/terminals', { query: { projectId } });
  },

  terminal(id: string, size?: { cols: number; rows: number }): Promise<{ terminal: TerminalInfo; replay: string }> {
    // A size makes the server lay the screen out for exactly these columns
    // (TerminalManager.attachView) — a snapshot of another width wraps.
    const query = size ? `?cols=${Math.round(size.cols)}&rows=${Math.round(size.rows)}` : '';
    return request('GET', `/api/terminals/${encodeURIComponent(id)}${query}`);
  },

  createTerminal(body: CreateTerminalRequest): Promise<{ terminal: TerminalInfo }> {
    return request('POST', '/api/terminals', { json: body });
  },

  killTerminal(id: string): Promise<void> {
    return request('DELETE', `/api/terminals/${encodeURIComponent(id)}`);
  },

  /** Routines (agents on recurring jobs) — server adds derived nextRunAt. */
  routines(projectId?: string): Promise<(Routine & { nextRunAt: number | null })[]> {
    return request('GET', '/api/routines', { query: { projectId } });
  },

  createRoutine(body: CreateRoutineRequest): Promise<Routine & { nextRunAt: number | null }> {
    return request('POST', '/api/routines', { json: body });
  },

  updateRoutine(id: string, body: UpdateRoutineRequest): Promise<Routine & { nextRunAt: number | null }> {
    return request('PATCH', `/api/routines/${encodeURIComponent(id)}`, { json: body });
  },

  deleteRoutine(id: string): Promise<void> {
    return request('DELETE', `/api/routines/${encodeURIComponent(id)}`);
  },

  fireRoutine(id: string): Promise<{ ok: boolean; status: string; sessionId?: string }> {
    return request('POST', `/api/routines/${encodeURIComponent(id)}/run`);
  },

  routineRuns(id: string, query: { limit?: number; before?: number } = {}): Promise<RunListResponse> {
    return request('GET', `/api/routines/${encodeURIComponent(id)}/runs`, { query });
  },

  /** A new webhook URL for the routine; the old one stops working. */
  renewRoutineHook(id: string): Promise<Routine & { nextRunAt: number | null }> {
    return request('POST', `/api/routines/${encodeURIComponent(id)}/hook-token`);
  },

  /** Account profiles (env overrides per agent). */
  accounts(agentId?: string): Promise<Account[]> {
    return request('GET', '/api/accounts', { query: { agentId } });
  },

  activeAccounts(): Promise<Record<string, string>> {
    return request('GET', '/api/accounts/active');
  },

  setActiveAccount(agentId: AgentId, accountId: string | null): Promise<Record<string, string>> {
    return request('PUT', '/api/accounts/active', { json: { agentId, accountId } });
  },

  /** New account with its own config folder; log in once in a terminal on it. */
  quickAccount(agentId: 'claude' | 'codex', name: string): Promise<Account> {
    return request('POST', '/api/accounts/quick', { json: { agentId, name } });
  },

  createAccount(body: CreateAccountRequest): Promise<Account> {
    return request('POST', '/api/accounts', { json: body });
  },

  deleteAccount(id: string): Promise<void> {
    return request('DELETE', `/api/accounts/${encodeURIComponent(id)}`);
  },

  /** Enhance: rewrite a rough draft into a crisp prompt (transient run). */
  enhance(body: EnhanceRequest): Promise<EnhanceResponse> {
    return request('POST', '/api/enhance', { json: body });
  },

  /* ------------------------------------------------------ mobile polish */

  /** One-tap agent launchers for the Code tab (availability probed on the server). */
  terminalPresets(refresh = false): Promise<TerminalPreset[]> {
    return request('GET', '/api/terminals/presets', { query: { refresh: refresh ? '1' : undefined } });
  },

  notifications(): Promise<DeckNotification[]> {
    return request('GET', '/api/notifications');
  },

  pushStatus(): Promise<PushStatus> {
    return request('GET', '/api/push');
  },

  /** Installs the Firebase service-account key (JSON text); the server checks it with Google. */
  setFcmKey(key: string): Promise<{ fcm: true; projectId: string }> {
    return request('POST', '/api/push/fcm/key', { json: { key } });
  },

  pushSubscribe(body: PushSubscribeRequest): Promise<void> {
    return request('POST', '/api/push/subscribe', { json: body });
  },

  pushUnsubscribe(endpoint?: string): Promise<void> {
    return request('POST', '/api/push/unsubscribe', { json: { endpoint } });
  },

  fcmRegister(body: FcmRegisterRequest): Promise<void> {
    return request('POST', '/api/push/fcm', { json: body });
  },

  fcmUnregister(token?: string): Promise<void> {
    return request('POST', '/api/push/fcm/unregister', { json: { token } });
  },

  pushTest(): Promise<{ delivered: number }> {
    return request('POST', '/api/push/test');
  },

  voiceStatus(): Promise<VoiceStatus> {
    return request('GET', '/api/voice');
  },

  async transcribe(audio: Blob, lang?: string): Promise<{ text: string }> {
    const form = new FormData();
    const ext = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm';
    form.append('file', audio, `dictation.${ext}`);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${base()}/api/voice/transcribe${qs({ lang })}`, { method: 'POST', headers, body: form });
    } catch {
      throw new ApiError('Cannot reach the AgentDeck server', 0);
    }
    if (res.status === 401) emitUnauthorized();
    if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
    return (await res.json()) as { text: string };
  },

  gitChanges(projectId: string): Promise<GitChange[]> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/changes`);
  },

  gitDiff(projectId: string, path?: string): Promise<GitDiffResponse> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/diff`, { query: { path } });
  },

  gitLog(projectId: string, limit = 40): Promise<GitCommitInfo[]> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/log`, { query: { limit } });
  },

  gitShow(projectId: string, hash: string): Promise<GitDiffResponse> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/show/${encodeURIComponent(hash)}`);
  },

  gitBranches(projectId: string): Promise<GitBranches> {
    return request('GET', `/api/projects/${encodeURIComponent(projectId)}/git/branches`);
  },

  gitCheckout(projectId: string, branch: string, create = false): Promise<GitOpResult> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/checkout`, { json: { branch, create } });
  },

  gitPull(projectId: string): Promise<GitOpResult> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/pull`);
  },

  gitFetch(projectId: string): Promise<GitOpResult> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/fetch`);
  },

  gitDiscard(projectId: string, path: string): Promise<void> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/discard`, { json: { path } });
  },

  gitSuggestMessage(projectId: string, body: { agentId?: string; files?: string[] }): Promise<{ text: string }> {
    return request('POST', `/api/projects/${encodeURIComponent(projectId)}/git/suggest-message`, { json: body });
  },
};

/**
 * Multipart upload with progress. Per contract the upload endpoint lives at
 * /api/projects/:id/files/upload?dir=… (multipart field `file`) and returns a
 * signed Attachment — session attachments use the same route, and so do files
 * for a terminal (`terminalId`; the answer then carries the server `path`).
 * `save.name` stores a project upload under exactly that name (409 EXISTS
 * when taken, unless `save.overwrite`); without it the server prefixes an id.
 */
export function uploadFile(
  projectId: string,
  file: File,
  dir = 'uploads',
  onProgress?: (fraction: number) => void,
  sessionId?: string,
  terminalId?: string,
  save?: { name: string; overwrite?: boolean },
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `${base()}/api/projects/${encodeURIComponent(projectId)}/files/upload?${terminalId ? `terminalId=${encodeURIComponent(terminalId)}&dir=${encodeURIComponent(dir)}` : sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : `dir=${encodeURIComponent(dir)}${save ? `&name=${encodeURIComponent(save.name)}${save.overwrite ? '&overwrite=1' : ''}` : ''}`}`,
    );
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status === 401) emitUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment);
        } catch {
          reject(new ApiError('Invalid upload response', xhr.status));
        }
      } else {
        let message = `Upload failed (HTTP ${xhr.status})`;
        try {
          const data = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (data?.error?.message) message = data.error.message;
        } catch {
          /* not json */
        }
        reject(new ApiError(message, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
    xhr.onabort = () => reject(new ApiError('Upload cancelled', 0));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/** Authed blob fetch (previews + downloads via signed-URL-free path). */
export async function fetchBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(base() + path, { headers });
  } catch {
    throw new ApiError('Cannot reach the AgentDeck server', 0);
  }
  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError('Unauthorized — pair again', 401);
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  return res.blob();
}
