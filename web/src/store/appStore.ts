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
  CloneProjectRequest,
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

/* ------------------------------------------------------------------ router */

export type Route =
  | { name: 'home' }
  | { name: 'chat' }
  | { name: 'code' }
  | { name: 'files' }
  | { name: 'github' }
  | { name: 'settings' }
  | { name: 'team'; runId: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (h === 'chat') return { name: 'chat' };
  if (h === 'code') return { name: 'code' };
  if (h === 'files') return { name: 'files' };
  if (h === 'github') return { name: 'github' };
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
  /** One-shot fetch of GET /api/usage (settings screen, agent sheet). */
  refreshUsage(): Promise<void>;
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
  /** Opens a PTY in the active (or given) project and focuses it. */
  createTerminal(projectId: string, cols: number, rows: number): Promise<TerminalInfo>;
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

      if (get().token) {
        attachSocket();
        void get().bootstrap();
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

    async refreshUsage() {
      try {
        set({ usage: await api.getUsage() });
      } catch (err) {
        get().toast('error', errorMessage(err));
      }
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
      if (existing && get().activeProjectId !== existing.projectId) {
        set({ activeProjectId: existing.projectId });
        persistActiveProject(existing.projectId);
      }
      set({ activeSessionId: id });
      if (get().loadedSessions[id]) return;
      const { session, messages } = await api.session(id);
      set((st) => ({
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

    async createTerminal(projectId, cols, rows) {
      const { terminal } = await api.createTerminal({ projectId, cols, rows });
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
