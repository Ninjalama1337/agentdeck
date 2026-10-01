/**
 * Central zustand store: hash router, auth, socket wiring and all live
 * session/team state. Screens do one-shot REST calls themselves; everything
 * shared across screens lives here.
 */
import { create } from 'zustand';
import type {
  Account,
  AdminJob,
  AdminJobKind,
  AgentId,
  AgentInfo,
  AgentUsage,
  ApkInfo,
  Attachment,
  ChatMessage,
  CreateAccountRequest,
  CreateProjectRequest,
  CreateRoutineRequest,
  CreateSessionRequest,
  CreateTerminalRequest,
  CloneProjectRequest,
  DeckNotification,
  DeviceInfo,
  MessageUsage,
  PairResponse,
  PermissionMode,
  Project,
  Routine,
  Session,
  SessionStatus,
  TeamRun,
  TeamRunRequest,
  TerminalInfo,
  TerminalPreset,
  UpdateRoutineRequest,
} from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import {
  api,
  getApiBase,
  getToken,
  setApiBase as persistApiBase,
  setToken as persistToken,
} from '../api/client';
import { connectSocket, disconnectSocket, emitInterrupt, getSocket } from '../api/socket';
import { usePrefs } from './prefs';
import { haptic } from '../util/haptics';
import { currentPushSubscription, showSystemNotification } from '../util/notify';

/* ------------------------------------------------------------------ router */

export type Route =
  | { name: 'home' }
  | { name: 'chat' }
  | { name: 'code' }
  | { name: 'files' }
  | { name: 'git' }
  | { name: 'settings' }
  | { name: 'team'; runId: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (h === 'chat') return { name: 'chat' };
  if (h === 'code') return { name: 'code' };
  if (h === 'files') return { name: 'files' };
  if (h === 'git' || h === 'github') return { name: 'git' };
  if (h === 'settings') return { name: 'settings' };
  if (h.startsWith('team/')) return { name: 'team', runId: h.slice('team/'.length) };
  return { name: 'home' };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'team':
      return `#/team/${encodeURIComponent(route.runId)}`;
    default:
      return `#/${route.name}`;
  }
}

/* ------------------------------------------------------------------- types */

export interface ToolCard {
  id: number;
  tool: string;
  state: 'running' | 'done' | 'error';
  summary?: string;
}

export interface StreamDraft {
  text: string;
  /** Model reasoning stream — rendered separately from the answer. */
  thinking?: string;
  tools: ToolCard[];
  usage?: MessageUsage;
}

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface LightboxState {
  url: string;
  name?: string;
}

/** One watcher event, flattened for the file-editor pub/sub (capped list). */
export interface FileEventRecord {
  projectId: string;
  /** Project-relative path with forward slashes. */
  path: string;
  type: 'change' | 'create' | 'delete';
  ts: number;
}

/* ----------------------------------------------------------------- helpers */

const PROJECT_KEY = 'agentdeck:project';
const INBOX_KEY = 'agentdeck:inbox';
const INBOX_SEEN_KEY = 'agentdeck:inbox-seen';
const INBOX_CLEARED_KEY = 'agentdeck:inbox-cleared';
const INBOX_LIMIT = 80;
const MODEL_PREFS_KEY = 'agentdeck:model-prefs';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function persistActiveProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function selectSession(state: { sessionsByProject: Record<string, Session[]> }, id: string | null | undefined): Session | undefined {
  if (!id) return undefined;
  for (const list of Object.values(state.sessionsByProject)) {
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function upsertSessionMap(
  map: Record<string, Session[]>,
  session: Session,
): Record<string, Session[]> {
  const list = map[session.projectId] ?? [];
  const idx = list.findIndex((s) => s.id === session.id);
  const next = idx >= 0 ? list.map((s) => (s.id === session.id ? { ...s, ...session } : s)) : [session, ...list];
  return { ...map, [session.projectId]: next };
}

function upsertListById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) return list.map((x) => (x.id === item.id ? { ...x, ...item } : x));
  return [item, ...list];
}

/** Upsert one admin job, keeping the list sorted newest-first (capped client-side). */
function upsertAdminJob(list: AdminJob[], job: AdminJob): AdminJob[] {
  const idx = list.findIndex((j) => j.id === job.id);
  const next = idx >= 0 ? list.map((j) => (j.id === job.id ? { ...j, ...job } : j)) : [job, ...list];
  return next.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
}

/* ------------------------------------------------------------------- store */

export interface AppStore {
  /* state */
  token: string | null;
  serverBase: string;
  serverInfo: PairResponse['server'] | null;
  connection: 'online' | 'offline';
  booted: boolean;
  route: Route;
  agents: Partial<Record<AgentId, AgentInfo>>;
  agentOrder: AgentId[];
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  sessionsByProject: Record<string, Session[]>;
  loadedSessions: Record<string, boolean>;
  messagesBySession: Record<string, ChatMessage[]>;
  drafts: Record<string, StreamDraft>;
  teamRuns: TeamRun[];
  devices: DeviceInfo[];
  /** Agent admin jobs (update/install/login), newest first — live via WS. */
  adminJobs: AdminJob[];
  toasts: Toast[];
  lightbox: LightboxState | null;
  pendingFiles: File[];
  modelPrefs: Partial<Record<AgentId, string>>;
  /** Metadata of the latest APK on the server (null = unknown / unreachable). */
  apkInfo: ApkInfo | null;
  /** Subscription usage per agent (null = not fetched yet). */
  usage: AgentUsage[] | null;
  /** Agent shown in the top-left usage button: follows the agent in use (hooks/useUsageTracking), or a manual pick. */
  currentUsageAgent: AgentId;
  /** Whether the full usage sheet is currently open. */
  usageSheetOpen: boolean;
  /** Soft keyboard visible (visualViewport heuristic) — hides the tab bar. */
  keyboardOpen: boolean;
  /** Number of currently open Sheets — any open sheet hides the tab bar. */
  overlayDepth: number;
  /** Per-project counter bumped on every files:changed batch / agent run end. */
  filesVersion: Record<string, number>;
  /** Recent watcher events (capped at 50) — FileEditorSheet watches this list. */
  fileEvents: FileEventRecord[];
  /* BridgeMind ports (0.9) */
  /** Live PTY terminals (Code tab). Output itself streams via xterm bridges. */
  terminals: TerminalInfo[];
  activeTerminalId: string | null;
  /** Routines (agents on recurring jobs) keyed by id. */
  routines: Record<string, Routine & { nextRunAt: number | null }>;
  routinesLoaded: boolean;
  /** Account profiles per agent (env overrides). */
  accounts: Account[];
  accountsLoaded: boolean;
  /* mobile polish */
  /** Notification inbox (newest first, persisted per device). */
  inbox: DeckNotification[];
  /** ts of the newest notification the user has looked at. */
  inboxSeenAt: number;
  /** Agent launch presets for the Code tab (null = not fetched). */
  terminalPresets: TerminalPreset[] | null;
  /** Preset id requested via app shortcut (?launch=claude) — consumed by the Code tab. */
  pendingLaunch: string | null;
  /** This browser has an active Web Push subscription (server pushes when hidden). */
  pushActive: boolean;

  /* actions */
  init(): void;
  navigate(route: Route): void;
  bootstrap(silent?: boolean): Promise<void>;
  pair(code: string, deviceName: string): Promise<void>;
  unpair(silent?: boolean): void;
  setServerBase(base: string): void;
  refreshDevices(): Promise<void>;
  /** One-shot fetch of GET /api/apk/info (app start, settings screen). */
  refreshApkInfo(): Promise<void>;
  /** Fetch GET /api/usage. `silent` (background polling) keeps the old numbers and skips the error toast. */
  refreshUsage(opts?: { silent?: boolean }): Promise<void>;
  /** Switch the active agent shown in the top-left usage circle button. */
  setCurrentUsageAgent(agentId: AgentId): void;
  /** Open or close the full usage details sheet. */
  setUsageSheetOpen(open: boolean): void;
  /** One-shot fetch of GET /api/admin/jobs (settings screen). */
  refreshAdminJobs(): Promise<void>;
  /** Start an update/install/login job (409 → toast when one already runs). */
  startAdminJob(agentId: AgentId, kind: AdminJobKind): Promise<AdminJob>;
  setKeyboardOpen(open: boolean): void;
  /** Sheet opened — increments overlayDepth (tab bar hides while > 0). */
  pushOverlay(): void;
  /** Sheet closed/unmounted — decrements overlayDepth (leak-safe at 0). */
  popOverlay(): void;
  /** Signals "project files may have changed" — FilesScreen refreshes debounced. */
  bumpFilesVersion(projectId: string): void;
  upsertProject(project: Project): void;
  setActiveProject(id: string | null): void;
  openProject(id: string): Promise<void>;
  refreshSessions(projectId: string): Promise<void>;
  createProject(req: CreateProjectRequest): Promise<Project>;
  cloneProject(req: CloneProjectRequest): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  createSession(req: CreateSessionRequest): Promise<Session>;
  openSession(id: string): Promise<void>;
  closeSession(): void;
  deleteSession(id: string): Promise<void>;
  sendTurn(sessionId: string, text: string, attachments: Attachment[], model?: string, thinkingEffort?: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  openInIde(sessionId: string): Promise<void>;
  setSessionModel(sessionId: string, model: string | undefined): void;
  setSessionEffort(sessionId: string, effort: string | undefined): void;
  setModelPref(agentId: AgentId, model: string | undefined): void;
  launchTeam(req: TeamRunRequest): Promise<TeamRun>;
  fetchTeamRuns(projectId?: string): Promise<void>;
  upsertTeamRun(run: TeamRun): void;
  /* BridgeMind ports (0.9) */
  /** Opens a PTY (optionally launching an agent preset) and focuses it. */
  createTerminal(
    projectId: string,
    cols: number,
    rows: number,
    launch?: Pick<CreateTerminalRequest, 'presetId' | 'variantId' | 'command' | 'title'>,
  ): Promise<TerminalInfo>;
  refreshTerminalPresets(force?: boolean): Promise<void>;
  /** Tells the server the user looked at a terminal (clears attention). */
  markTerminalSeen(id: string): void;
  setPendingLaunch(presetId: string | null): void;
  /** Deep link from a notification / shortcut: "session:<id>", "terminal:<id>", "team:<id>". */
  openTarget(target: string): void;
  markInboxSeen(): void;
  clearInbox(): void;
  refreshPushActive(): Promise<void>;
  killTerminal(id: string): Promise<void>;
  setActiveTerminal(id: string | null): void;
  refreshTerminals(): Promise<void>;
  /** Streams terminal output to a subscriber (xterm). Returns an unsubscribe. */
  subscribeTerminal(id: string, onData: (data: string) => void, onExit?: (code: number) => void): () => void;
  sendTerminalInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  refreshRoutines(projectId?: string): Promise<void>;
  createRoutine(req: CreateRoutineRequest): Promise<Routine>;
  updateRoutine(id: string, req: UpdateRoutineRequest): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  fireRoutine(id: string): Promise<{ ok: boolean; status: string; sessionId?: string }>;
  refreshAccounts(): Promise<void>;
  createAccount(req: CreateAccountRequest): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  toast(level: Toast['level'], text: string): void;
  dismissToast(id: number): void;
  setLightbox(lightbox: LightboxState | null): void;
  queuePendingFiles(files: File[]): void;
  takePendingFiles(): File[];
}

let initialized = false;
let socketAttached = false;
let toolSeq = 0;
let tmpMsgSeq = 0;
let toastSeq = 0;
/** Admin job ids we already toasted a done/error for (WS replays the full job). */
const toastedAdminJobs = new Set<string>();
function loadInbox(): DeckNotification[] {
  return readJson<DeckNotification[]>(INBOX_KEY, []).slice(0, INBOX_LIMIT);
}

/** Per-terminal output subscribers (xterm instances). Keyed by terminal id. */
const terminalSubs = new Map<string, { onData: (data: string) => void; onExit?: (code: number) => void }>();

/** Client mirror of the server's pure nextRunAt (docs/CONTRACT.md). */
export function routineNextRunAt(routine: Routine, now = Date.now()): number | null {
  if (!routine.enabled) return null;
  const anchor = routine.lastRunAt ?? routine.createdAt;
  const schedule = routine.schedule;
  if (schedule.kind === 'interval') return anchor + schedule.minutes * 60_000;
  const [h, m] = schedule.time.split(':').map(Number);
  const base = new Date(anchor);
  base.setHours(h || 0, m || 0, 0, 0);
  let candidate = base.getTime();
  if (candidate <= Math.max(anchor, now - 30_000)) candidate += 86_400_000;
  if (schedule.kind === 'daily') return candidate;
  for (let i = 0; i < 8; i++) {
    const c = candidate + i * 86_400_000;
    if (new Date(c).getDay() === schedule.weekday) return c;
  }
  return candidate + 7 * 86_400_000;
}

export const useAppStore = create<AppStore>()((set, get) => {
  /* --- socket wiring --------------------------------------------------- */

  function attachSocket(): void {
    const socket = connectSocket();
    if (socketAttached) return;
    socketAttached = true;

    socket.on('connect', () => {
      set({ connection: 'online' });
      void get().bootstrap(true);
      void syncInbox();
    });
    socket.on('disconnect', () => {
      set({ connection: 'offline' });
    });
    socket.on('connect_error', () => {
      set({ connection: 'offline' });
    });

    socket.on('session:event', ({ sessionId, event }) => {
      switch (event.type) {
        case 'status': {
          applyStatus(sessionId, event.status, event.detail);
          break;
        }
        case 'text-delta': {
          set((st) => {
            const draft = st.drafts[sessionId] ?? { text: '', tools: [] };
            return {
              drafts: { ...st.drafts, [sessionId]: { ...draft, text: draft.text + event.text } },
            };
          });
          break;
        }
        case 'thinking-delta': {
          set((st) => {
            const draft = st.drafts[sessionId] ?? { text: '', tools: [] };
            return {
              drafts: {
                ...st.drafts,
                [sessionId]: { ...draft, thinking: (draft.thinking ?? '') + event.text },
              },
            };
          });
          break;
        }
        case 'message': {
          appendMessage(sessionId, event.message);
          if (event.message.role !== 'user') {
            finalizeDraft(sessionId, event.message);
          }
          break;
        }
        case 'tool-use': {
          set((st) => {
            const draft = st.drafts[sessionId] ?? { text: '', tools: [] };
            const card: ToolCard = { id: ++toolSeq, tool: event.tool, state: 'running', summary: event.summary };
            return {
              drafts: { ...st.drafts, [sessionId]: { ...draft, tools: [...draft.tools, card] } },
            };
          });
          break;
        }
        case 'tool-result': {
          set((st) => {
            const draft = st.drafts[sessionId];
            if (!draft) return {};
            const idx = [...draft.tools].reverse().findIndex((t) => t.tool === event.tool && t.state === 'running');
            let tools: ToolCard[];
            if (idx >= 0) {
              const real = draft.tools.length - 1 - idx;
              tools = draft.tools.map((t, i) =>
                i === real ? { ...t, state: event.ok ? ('done' as const) : ('error' as const), summary: event.summary ?? t.summary } : t,
              );
            } else {
              tools = [
                ...draft.tools,
                { id: ++toolSeq, tool: event.tool, state: event.ok ? ('done' as const) : ('error' as const), summary: event.summary },
              ];
            }
            return { drafts: { ...st.drafts, [sessionId]: { ...draft, tools } } };
          });
          break;
        }
        case 'usage': {
          const usage: MessageUsage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
          };
          set((st) => {
            const draft = st.drafts[sessionId];
            return {
              drafts: draft ? { ...st.drafts, [sessionId]: { ...draft, usage } } : st.drafts,
            };
          });
          break;
        }
        case 'raw':
          break;
      }
    });

    socket.on('session:update', ({ session }) => {
      set((st) => ({ sessionsByProject: upsertSessionMap(st.sessionsByProject, session) }));
    });

    socket.on('project:update', ({ project }) => {
      get().upsertProject(project);
    });

    socket.on('agent:update', ({ agent }) => {
      set((st) => ({ agents: { ...st.agents, [agent.id]: agent } }));
    });

    socket.on('team:update', ({ run }) => {
      get().upsertTeamRun(run);
    });

    socket.on('routine:update', ({ routine }) => {
      set((st) => ({
        routines: {
          ...st.routines,
          [routine.id]: { ...routine, nextRunAt: routineNextRunAt(routine) },
        },
      }));
    });

    socket.on('routine:deleted', ({ id }) => {
      set((st) => {
        const routines = { ...st.routines };
        delete routines[id];
        return { routines };
      });
    });

    socket.on('terminal:data', ({ id, data }) => {
      terminalSubs.get(id)?.onData(data);
    });

    socket.on('terminal:exit', ({ id, code }) => {
      set((st) => ({ terminals: st.terminals.filter((t) => t.id !== id) }));
      terminalSubs.get(id)?.onExit?.(code);
      terminalSubs.delete(id);
      set((st) => ({
        activeTerminalId: st.activeTerminalId === id ? (st.terminals[0]?.id ?? null) : st.activeTerminalId,
      }));
    });

    socket.on('terminal:list', ({ terminals }) => {
      set({ terminals });
    });

    // Live admin job progress — the server throttles broadcasts (~4/s) and we
    // replace the job object exactly once per event, so re-render cost stays flat.
    socket.on('admin:job', ({ job }) => {
      set((st) => ({ adminJobs: upsertAdminJob(st.adminJobs, job) }));
      if (job.status !== 'done' && job.status !== 'error') return;
      if (toastedAdminJobs.has(job.id)) return;
      toastedAdminJobs.add(job.id);
      const label = agentDisplayName(get().agents[job.agentId], job.agentId);
      const kind = ADMIN_KIND_LABELS[job.kind].toLowerCase();
      if (job.status === 'done') {
        get().toast('info', `${label} ${kind} finished`);
      } else {
        get().toast('error', job.error?.trim() || `${label} ${kind} failed (exit code ${job.exitCode ?? 'unknown'})`);
      }
    });

    socket.on('files:changed', ({ projectId, events }) => {
      set((st) => {
        const now = Date.now();
        const incoming: FileEventRecord[] = events.map((e) => ({
          projectId,
          path: e.path,
          type: e.type,
          ts: now,
        }));
        return {
          filesVersion: { ...st.filesVersion, [projectId]: (st.filesVersion[projectId] ?? 0) + 1 },
          fileEvents: [...st.fileEvents, ...incoming].slice(-50),
        };
      });
    });

    socket.on('notify', ({ level, text }) => {
      get().toast(level, text);
    });

    socket.on('terminal:attention', ({ id }) => {
      set((st) => ({ terminals: st.terminals.map((t) => (t.id === id ? { ...t, attention: true } : t)) }));
    });

    socket.on('notification', ({ notification }) => {
      receiveNotification(notification);
    });
  }

  /**
   * Catch up on notifications that fired while this device was offline (app
   * suspended in the background, network gone): they land in the inbox
   * quietly, without a toast or system notification.
   */
  async function syncInbox(): Promise<void> {
    try {
      const recent = await api.notifications();
      const clearedAt = readJson<number>(INBOX_CLEARED_KEY, 0);
      set((st) => {
        const known = new Set(st.inbox.map((n) => n.id));
        const missed = recent.filter((n) => n.ts > clearedAt && !known.has(n.id));
        if (missed.length === 0) return {};
        const inbox = [...missed, ...st.inbox].sort((a, b) => b.ts - a.ts).slice(0, INBOX_LIMIT);
        writeJson(INBOX_KEY, inbox);
        return { inbox };
      });
    } catch {
      /* older server without the notifications route */
    }
  }

  /** Inbox + (when the app is not in front) a system notification. */
  function receiveNotification(n: DeckNotification): void {
    // The same event can arrive twice (socket + push relay, inbox sync).
    if (get().inbox.some((x) => x.id === n.id)) return;
    set((st) => {
      const inbox = [n, ...st.inbox].slice(0, INBOX_LIMIT);
      writeJson(INBOX_KEY, inbox);
      return { inbox };
    });
    const prefs = usePrefs.getState();
    const st = get();
    // Already looking at exactly this thing → nothing to announce.
    const looking =
      document.visibilityState === 'visible' &&
      ((n.sessionId && st.route.name === 'chat' && st.activeSessionId === n.sessionId) ||
        (n.terminalId && st.route.name === 'code' && st.activeTerminalId === n.terminalId));
    if (looking) {
      if (n.terminalId) get().markTerminalSeen(n.terminalId);
      return;
    }
    if (!prefs.notifyKinds[n.kind]) return;
    if (document.visibilityState === 'visible') {
      haptic(n.kind.endsWith('error') ? 'warning' : 'success');
      get().toast(n.kind.endsWith('error') ? 'error' : 'info', `${n.title} — ${n.body}`);
      return;
    }
    // Hidden: Web Push (service worker) covers it when subscribed.
    if (prefs.notifications && !st.pushActive) void showSystemNotification(n);
  }

  function applyStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    set((st) => {
      const session = selectSession(st, sessionId);
      if (!session) return {};
      const next = { ...session, status, lastError: status === 'error' && detail ? detail : session.lastError };
      const patch: Partial<AppStore> = { sessionsByProject: upsertSessionMap(st.sessionsByProject, next) };
      if (status === 'idle' || status === 'error' || status === 'stopped') {
        if (st.drafts[sessionId]) {
          const drafts = { ...st.drafts };
          delete drafts[sessionId];
          patch.drafts = drafts;
        }
      }
      return patch;
    });
    if (status === 'error' && detail) get().toast('error', detail);
    // A finished run may have written files — a redundant bump here makes the
    // Files screen feel instant (the watcher covers the same changes anyway).
    if (status === 'idle' || status === 'error') {
      const session = selectSession(get(), sessionId);
      if (session) get().bumpFilesVersion(session.projectId);
    }
  }

  function appendMessage(sessionId: string, message: ChatMessage): void {
    set((st) => {
      const list = st.messagesBySession[sessionId] ?? [];
      if (list.some((m) => m.id === message.id)) return {};
      return { messagesBySession: { ...st.messagesBySession, [sessionId]: [...list, message] } };
    });
  }

  function finalizeDraft(sessionId: string, message: ChatMessage): void {
    set((st) => {
      const draft = st.drafts[sessionId];
      const list = st.messagesBySession[sessionId] ?? [];
      const patch: Partial<AppStore> = {};
      if (draft) {
        const drafts = { ...st.drafts };
        delete drafts[sessionId];
        patch.drafts = drafts;
      }
      if (!message.usage && draft?.usage) {
        patch.messagesBySession = {
          ...st.messagesBySession,
          [sessionId]: list.map((m) => (m.id === message.id ? { ...m, usage: draft.usage } : m)),
        };
      }
      return patch;
    });
  }

  /* --- store ------------------------------------------------------------ */

  return {
    token: getToken(),
    serverBase: getApiBase(),
    serverInfo: null,
    connection: 'online',
    booted: false,
    route: parseHash(window.location.hash),
    agents: {},
    agentOrder: [],
    projects: [],
    activeProjectId: (() => {
      try {
        return localStorage.getItem(PROJECT_KEY);
      } catch {
        return null;
      }
    })(),
    activeSessionId: null,
    sessionsByProject: {},
    loadedSessions: {},
    messagesBySession: {},
    drafts: {},
    teamRuns: [],
    devices: [],
    adminJobs: [],
    toasts: [],
    lightbox: null,
    pendingFiles: [],
    modelPrefs: readJson<Partial<Record<AgentId, string>>>(MODEL_PREFS_KEY, {}),
    apkInfo: null,
    usage: null,
    currentUsageAgent: 'claude',
    usageSheetOpen: false,
    keyboardOpen: false,
    overlayDepth: 0,
    filesVersion: {},
    fileEvents: [],
    terminals: [],
    activeTerminalId: null,
    routines: {},
    routinesLoaded: false,
    accounts: [],
    accountsLoaded: false,
    inbox: loadInbox(),
    inboxSeenAt: readJson<number>(INBOX_SEEN_KEY, 0),
    terminalPresets: null,
    pendingLaunch: null,
    pushActive: false,

    init() {
      if (initialized) return;
      initialized = true;

      if (!window.location.hash) window.history.replaceState(null, '', '#/');
      set({ route: parseHash(window.location.hash) });
      window.addEventListener('hashchange', () => {
        set({ route: parseHash(window.location.hash) });
      });
      window.addEventListener('agentdeck:unauthorized', () => {
        if (get().token) {
          get().unpair(true);
          get().toast('warn', 'Pairing expired — enter the code again');
        }
      });

      // Notification taps (service worker / native plugin) and shortcuts.
      window.addEventListener('agentdeck:open', (e) => {
        const target = (e as CustomEvent<string>).detail;
        if (typeof target === 'string') get().openTarget(target);
      });
      navigator.serviceWorker?.addEventListener('message', (e) => {
        const data = e.data as { type?: string; open?: string; notification?: DeckNotification } | undefined;
        if (data?.type === 'agentdeck:open' && data.open) get().openTarget(data.open);
        // Push that arrived while the app is in front (the service worker
        // relays it instead of showing it) — covers a socket that is still
        // reconnecting.
        if (data?.type === 'agentdeck:push' && data.notification?.id) receiveNotification(data.notification);
      });

      if (get().token) {
        attachSocket();
        void get().bootstrap();
        void get().refreshPushActive();
      }

      // Public route — also fetched while unpaired so the pairing screen can
      // offer the APK download. One shot, no polling loop.
      void get().refreshApkInfo();
    },

    navigate(route) {
      const hash = routeToHash(route);
      if (window.location.hash === hash) set({ route });
      else window.location.hash = hash;
    },

    async bootstrap(silent = false) {
      const { token } = get();
      if (!token) return;
      try {
        const [agents, projects] = await Promise.all([api.agents(), api.projects()]);
        const order = agents.map((a) => a.id);
        const map: Partial<Record<AgentId, AgentInfo>> = {};
        for (const a of agents) map[a.id] = a;

        const stored = get().activeProjectId;
        const active = stored && projects.some((p) => p.id === stored) ? stored : (projects[0]?.id ?? null);

        set({ agents: map, agentOrder: order, projects, activeProjectId: active, booted: true, connection: 'online' });
        persistActiveProject(active);

        const jobs: Promise<unknown>[] = [
          get().refreshTerminalPresets(),
          get().refreshDevices(),
          get().fetchTeamRuns(),
          get().refreshTerminals(),
          get().refreshRoutines(),
          get().refreshAccounts(),
        ];
        if (active) jobs.push(get().refreshSessions(active));
        await Promise.allSettled(jobs);
      } catch (err) {
        if (!silent) get().toast('error', errorMessage(err));
      }
    },

    async pair(code, deviceName) {
      const res = await api.pair({ code, deviceName });
      persistToken(res.token);
      set({ token: res.token, serverInfo: res.server, connection: 'online' });
      attachSocket();
      get().toast('info', `Paired with ${res.server.name}`);
      await get().bootstrap();
    },

    unpair(silent = false) {
      disconnectSocket();
      socketAttached = false;
      persistToken(null);
      persistActiveProject(null);
      set({
        token: null,
        serverInfo: null,
        booted: false,
        agents: {},
        agentOrder: [],
        projects: [],
        activeProjectId: null,
        activeSessionId: null,
        sessionsByProject: {},
        loadedSessions: {},
        messagesBySession: {},
        drafts: {},
        teamRuns: [],
        devices: [],
        adminJobs: [],
        overlayDepth: 0,
        filesVersion: {},
        fileEvents: [],
        terminals: [],
        activeTerminalId: null,
      });
      toastedAdminJobs.clear();
      get().navigate({ name: 'home' });
      if (!silent) get().toast('info', 'Unpaired from server');
    },

    setServerBase(base) {
      persistApiBase(base);
      set({ serverBase: base.trim().replace(/\/+$/, '') });
      disconnectSocket();
      socketAttached = false;
      if (get().token) {
        attachSocket();
        void get().bootstrap();
      }
    },

    async refreshDevices() {
      try {
        set({ devices: await api.devices() });
      } catch {
        /* non-fatal */
      }
    },

    async refreshApkInfo() {
      try {
        set({ apkInfo: await api.getApkInfo() });
      } catch {
        /* non-fatal — card/banner stay hidden when the server is unreachable */
      }
    },

    async refreshUsage(opts) {
      try {
        set({ usage: await api.getUsage() });
      } catch (err) {
        if (!opts?.silent) get().toast('error', errorMessage(err));
      }
    },

    setCurrentUsageAgent(currentUsageAgent) {
      set({ currentUsageAgent });
    },

    setUsageSheetOpen(usageSheetOpen) {
      set({ usageSheetOpen });
    },

    async refreshAdminJobs() {
      try {
        const jobs = await api.adminJobs();
        set((st) => {
          // Merge so a job that just appeared via WS is never regressed.
          const map = new Map(st.adminJobs.map((j) => [j.id, j]));
          for (const job of jobs) map.set(job.id, job);
          const adminJobs = [...map.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
          return { adminJobs };
        });
      } catch {
        /* non-fatal — older servers simply have no admin section */
      }
    },

    async startAdminJob(agentId, kind) {
      try {
        // No optimistic entry: the 202 response (or the first admin:job event)
        // lands within a beat and carries the server's real job object.
        const job = await api.startAdminJob({ agentId, kind });
        set((st) => ({ adminJobs: upsertAdminJob(st.adminJobs, job) }));
        return job;
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as { status?: number }).status : undefined;
        if (status === 409) get().toast('warn', 'Another admin job is already running');
        else get().toast('error', errorMessage(err));
        throw err;
      }
    },

    setKeyboardOpen(open) {
      if (get().keyboardOpen !== open) set({ keyboardOpen: open });
    },

    pushOverlay() {
      set((st) => ({ overlayDepth: st.overlayDepth + 1 }));
    },

    popOverlay() {
      // Clamped at 0 so an out-of-order cleanup can never leak a negative depth.
      set((st) => ({ overlayDepth: Math.max(0, st.overlayDepth - 1) }));
    },

    bumpFilesVersion(projectId) {
      set((st) => ({
        filesVersion: { ...st.filesVersion, [projectId]: (st.filesVersion[projectId] ?? 0) + 1 },
      }));
    },

    upsertProject(project) {
      set((st) => ({ projects: upsertListById(st.projects, project) }));
    },

    setActiveProject(id) {
      set({ activeProjectId: id, activeSessionId: null });
      persistActiveProject(id);
    },

    async openProject(id) {
      set({ activeProjectId: id, activeSessionId: null });
      persistActiveProject(id);
      await Promise.allSettled([get().refreshSessions(id), get().fetchTeamRuns(id)]);
    },

    async refreshSessions(projectId) {
      const sessions = await api.sessions(projectId);
      set((st) => ({
        sessionsByProject: { ...st.sessionsByProject, [projectId]: sessions },
      }));
    },

    async createProject(req) {
      const project = await api.createProject(req);
      get().upsertProject(project);
      return project;
    },

    async cloneProject(req) {
      const project = await api.cloneProject(req);
      get().upsertProject(project);
      return project;
    },

    async deleteProject(id) {
      await api.deleteProject(id);
      set((st) => {
        const projects = st.projects.filter((p) => p.id !== id);
        const activeProjectId = st.activeProjectId === id ? (projects[0]?.id ?? null) : st.activeProjectId;
        persistActiveProject(activeProjectId);
        return { projects, activeProjectId };
      });
      get().toast('info', 'Project removed from deck (files kept on server)');
    },

    async createSession(req) {
      const session = await api.createSession(req);
      set((st) => ({ sessionsByProject: upsertSessionMap(st.sessionsByProject, session) }));
      return session;
    },

    async openSession(id) {
      const existing = selectSession(get(), id);
      if (existing) {
        if (get().activeProjectId !== existing.projectId) {
          set({ activeProjectId: existing.projectId });
          persistActiveProject(existing.projectId);
        }
        set({ currentUsageAgent: existing.agentId });
      }
      set({ activeSessionId: id });
      if (get().loadedSessions[id]) return;
      const { session, messages } = await api.session(id);
      set((st) => ({
        currentUsageAgent: session.agentId,
        sessionsByProject: upsertSessionMap(st.sessionsByProject, session),
        messagesBySession: { ...st.messagesBySession, [id]: messages },
        loadedSessions: { ...st.loadedSessions, [id]: true },
      }));
    },

    closeSession() {
      set({ activeSessionId: null });
    },

    async deleteSession(id) {
      await api.deleteSession(id);
      set((st) => {
        const sessionsByProject: Record<string, Session[]> = {};
        for (const [pid, list] of Object.entries(st.sessionsByProject)) {
          sessionsByProject[pid] = list.filter((s) => s.id !== id);
        }
        const loadedSessions = { ...st.loadedSessions };
        delete loadedSessions[id];
        const messagesBySession = { ...st.messagesBySession };
        delete messagesBySession[id];
        const drafts = { ...st.drafts };
        delete drafts[id];
        return {
          sessionsByProject,
          loadedSessions,
          messagesBySession,
          drafts,
          activeSessionId: st.activeSessionId === id ? null : st.activeSessionId,
        };
      });
      get().toast('info', 'Session deleted');
    },

    async sendTurn(sessionId, text, attachments, model, thinkingEffort) {
      const tmpId = `tmp-${Date.now()}-${++tmpMsgSeq}`;
      const optimistic: ChatMessage = {
        id: tmpId,
        sessionId,
        role: 'user',
        text,
        attachments,
        ts: Date.now(),
      };
      appendMessage(sessionId, optimistic);
      applyStatus(sessionId, 'queued');
      try {
        const res = await api.sendTurn(sessionId, {
          text,
          attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
          model,
          thinkingEffort,
        });
        set((st) => {
          const list = st.messagesBySession[sessionId] ?? [];
          const realArrived = list.some((m) => m.id === res.userMessage.id);
          const next = realArrived
            ? list.filter((m) => m.id !== tmpId)
            : list.map((m) => (m.id === tmpId ? res.userMessage : m));
          return { messagesBySession: { ...st.messagesBySession, [sessionId]: next } };
        });
      } catch (err) {
        set((st) => {
          const list = (st.messagesBySession[sessionId] ?? []).filter((m) => m.id !== tmpId);
          return { messagesBySession: { ...st.messagesBySession, [sessionId]: list } };
        });
        applyStatus(sessionId, 'idle');
        const status = err instanceof Error && 'status' in err ? (err as { status?: number }).status : undefined;
        get().toast('error', status === 409 ? 'A run is already active — stop it first' : errorMessage(err));
        throw err;
      }
    },

    async interrupt(sessionId) {
      applyStatus(sessionId, 'stopped');
      try {
        await emitInterrupt(sessionId);
      } catch {
        try {
          await api.interrupt(sessionId);
        } catch (err) {
          applyStatus(sessionId, 'running');
          get().toast('error', errorMessage(err));
        }
      }
    },

    async openInIde(sessionId) {
      await api.openInIde(sessionId);
      get().toast('info', 'Opening project in the agent IDE…');
    },

    setSessionModel(sessionId, model) {
      set((st) => {
        const session = selectSession(st, sessionId);
        if (!session) return {};
        return {
          sessionsByProject: upsertSessionMap(st.sessionsByProject, { ...session, model }),
        };
      });
      const session = selectSession(get(), sessionId);
      if (session) get().setModelPref(session.agentId, model);
    },

    setSessionEffort(sessionId, effort) {
      set((st) => {
        const session = selectSession(st, sessionId);
        if (!session) return {};
        return {
          sessionsByProject: upsertSessionMap(st.sessionsByProject, {
            ...session,
            thinkingEffort: effort,
          }),
        };
      });
    },

    setModelPref(agentId, model) {
      set((st) => {
        const prefs = { ...st.modelPrefs };
        if (model) prefs[agentId] = model;
        else delete prefs[agentId];
        writeJson(MODEL_PREFS_KEY, prefs);
        return { modelPrefs: prefs };
      });
    },

    async launchTeam(req) {
      const run = await api.createTeamRun(req);
      get().upsertTeamRun(run);
      return run;
    },

    async fetchTeamRuns(projectId) {
      const runs = await api.teamRuns(projectId);
      set((st) => {
        const map = new Map(st.teamRuns.map((r) => [r.id, r]));
        for (const run of runs) map.set(run.id, run);
        const teamRuns = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        return { teamRuns };
      });
    },

    upsertTeamRun(run) {
      set((st) => ({
        teamRuns: upsertListById(st.teamRuns, run).sort((a, b) => b.updatedAt - a.updatedAt),
      }));
    },

    /* --- BridgeMind ports ------------------------------------------------- */

    async createTerminal(projectId, cols, rows, launch) {
      const { terminal } = await api.createTerminal({ projectId, cols, rows, ...(launch ?? {}) });
      set((st) => ({
        // The server's terminal:list WS broadcast usually beats the POST
        // response — append only when the list event hasn't landed yet.
        terminals: st.terminals.some((t) => t.id === terminal.id)
          ? st.terminals
          : [...st.terminals, terminal],
        activeTerminalId: terminal.id,
      }));
      return terminal;
    },

    async killTerminal(id) {
      terminalSubs.delete(id);
      set((st) => ({
        terminals: st.terminals.filter((t) => t.id !== id),
        activeTerminalId: st.activeTerminalId === id ? (st.terminals.find((t) => t.id !== id)?.id ?? null) : st.activeTerminalId,
      }));
      try {
        await api.killTerminal(id);
      } catch {
        // already exited — the terminal:exit event cleans up the list
      }
    },

    setActiveTerminal(id) {
      set({ activeTerminalId: id });
      if (id) get().markTerminalSeen(id);
    },

    async refreshTerminalPresets(force = false) {
      try {
        set({ terminalPresets: await api.terminalPresets(force) });
      } catch {
        /* older server — Code tab falls back to plain shells */
        if (!get().terminalPresets) set({ terminalPresets: [] });
      }
    },

    markTerminalSeen(id) {
      const term = get().terminals.find((t) => t.id === id);
      if (!term?.attention) return;
      set((st) => ({ terminals: st.terminals.map((t) => (t.id === id ? { ...t, attention: false } : t)) }));
      getSocket()?.emit('terminal:seen', { id });
    },

    setPendingLaunch(presetId) {
      set({ pendingLaunch: presetId });
    },

    openTarget(target) {
      const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      if (!id) return;
      if (kind === 'session') {
        get().navigate({ name: 'chat' });
        void get().openSession(id).catch(() => get().toast('warn', 'Session no longer exists'));
      } else if (kind === 'terminal') {
        get().navigate({ name: 'code' });
        if (get().terminals.some((t) => t.id === id)) get().setActiveTerminal(id);
        else get().toast('warn', 'That terminal has ended');
      } else if (kind === 'team') {
        get().navigate({ name: 'team', runId: id });
      }
    },

    markInboxSeen() {
      const newest = get().inbox[0]?.ts ?? Date.now();
      writeJson(INBOX_SEEN_KEY, newest);
      set({ inboxSeenAt: newest });
    },

    clearInbox() {
      writeJson(INBOX_KEY, []);
      writeJson(INBOX_CLEARED_KEY, Date.now());
      set({ inbox: [] });
    },

    async refreshPushActive() {
      const sub = await currentPushSubscription();
      set({ pushActive: sub !== null });
    },

    async refreshTerminals() {
      const terminals = await api.terminals();
      set((st) => ({
        terminals,
        activeTerminalId: terminals.some((t) => t.id === st.activeTerminalId) ? st.activeTerminalId : (terminals[0]?.id ?? null),
      }));
    },

    subscribeTerminal(id, onData, onExit) {
      terminalSubs.set(id, { onData, onExit });
      return () => {
        terminalSubs.delete(id);
      };
    },

    sendTerminalInput(id, data) {
      getSocket()?.emit('terminal:input', { id, data });
    },

    resizeTerminal(id, cols, rows) {
      getSocket()?.emit('terminal:resize', { id, cols, rows });
    },

    async refreshRoutines(projectId) {
      const routines = await api.routines(projectId);
      set((st) => {
        // WS keeps individual routines fresh; a fetch replaces the requested
        // scope while keeping others (fetch-all replaces everything).
        const map = projectId
          ? new Map(Object.entries(st.routines).filter(([, r]) => r.projectId !== projectId))
          : new Map<string, Routine & { nextRunAt: number | null }>();
        for (const r of routines) map.set(r.id, r);
        const next: Record<string, Routine & { nextRunAt: number | null }> = {};
        for (const r of map.values()) next[r.id] = r;
        return { routines: next, routinesLoaded: true };
      });
    },

    async createRoutine(req) {
      const routine = await api.createRoutine(req);
      set((st) => ({ routines: { ...st.routines, [routine.id]: routine } }));
      return routine;
    },

    async updateRoutine(id, req) {
      const routine = await api.updateRoutine(id, req);
      set((st) => ({ routines: { ...st.routines, [routine.id]: routine } }));
      return routine;
    },

    async deleteRoutine(id) {
      await api.deleteRoutine(id);
      set((st) => {
        const routines = { ...st.routines };
        delete routines[id];
        return { routines };
      });
    },

    async fireRoutine(id) {
      const result = await api.fireRoutine(id);
      if (result.ok && result.sessionId) void get().openSession(result.sessionId);
      return result;
    },

    async refreshAccounts() {
      const accounts = await api.accounts();
      set({ accounts, accountsLoaded: true });
    },

    async createAccount(req) {
      const account = await api.createAccount(req);
      set((st) => ({ accounts: [account, ...st.accounts] }));
      return account;
    },

    async deleteAccount(id) {
      await api.deleteAccount(id);
      set((st) => ({ accounts: st.accounts.filter((a) => a.id !== id) }));
    },

    toast(level, text) {
      const id = ++toastSeq;
      set((st) => ({ toasts: [...st.toasts.slice(-3), { id, level, text }] }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    },

    dismissToast(id) {
      set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
    },

    setLightbox(lightbox) {
      set({ lightbox });
    },

    queuePendingFiles(files) {
      set((st) => ({ pendingFiles: [...st.pendingFiles, ...files] }));
    },

    takePendingFiles() {
      const files = get().pendingFiles;
      if (files.length) set({ pendingFiles: [] });
      return files;
    },
  };
});

/* --------------------------------------------------------------- selectors */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Human permission-mode labels used by sheets. */
export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string; danger?: boolean }[] = [
  { value: 'default', label: 'Default', hint: 'Ask before every action' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan', hint: 'Plan first, then execute' },
  { value: 'bypass', label: 'Bypass', hint: 'No permission prompts at all', danger: true },
];

/** Human labels for admin job kinds — shared by Settings and AgentAdminSheet. */
export const ADMIN_KIND_LABELS: Record<AdminJobKind, string> = {
  update: 'Update',
  install: 'Install',
  login: 'Login',
};

export function agentDisplayName(agent: AgentInfo | undefined, id: AgentId): string {
  return agent?.label ?? AGENT_LABELS[id];
}
