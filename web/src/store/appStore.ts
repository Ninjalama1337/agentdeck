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
  AnswerPermissionRequest,
  ApkInfo,
  UpdateInfo,
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
  PairPendingResponse,
  PairRequestInfo,
  PairResponse,
  PermissionMode,
  Project,
  Routine,
  ServerToClientEvents,
  Session,
  SessionDetailResponse,
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
  ApiError,
  getApiBase,
  getToken,
  setApiBase as persistApiBase,
  setToken as persistToken,
} from '../api/client';
import { connectSocket, disconnectSocket, emitInterrupt, getSocket } from '../api/socket';
import {
  activateServer,
  addServer as addSavedServer,
  getActiveServer,
  listServers,
  removeServer as removeSavedServer,
  scopedKey,
  updateActiveServer,
} from '../api/servers';
import { usePrefs } from './prefs';
import {
  draftFromSnapshot,
  isCovered,
  lastServerMessageId,
  mergeHistory,
  reduceDraft,
  type StreamDraft,
  type StreamMark,
} from './sessionStream';
import { haptic } from '../util/haptics';
import type { IncomingShare } from '../util/shareTarget';
import { currentPushSubscription, fcmRegistered, showSystemNotification, stateOf } from '../util/notify';
import { desktopLayoutNow } from '../hooks/useDesktopLayout';
import { usePanes } from '../features/code/paneStore';
import { parseHash, routeToHash, startHash, validRoute, validSessionId, type Route } from './route';

/* ------------------------------------------------------------------ router */

// Route parsing and the restore rules live in route.ts (pure, tested).
export { parseHash, routeToHash };
export type { Route };

/* ------------------------------------------------------------------- types */

export type { StreamDraft, ToolCard } from './sessionStream';

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

// Per-server data: keyed by the active saved server. Resolved once per page
// load — changing the server reloads the app (see reloadApp).
const PROJECT_KEY = scopedKey('agentdeck:project');
/** Where the user left off: last screen (hash) and open chat session. */
const ROUTE_KEY = scopedKey('agentdeck:route');
const SESSION_KEY = scopedKey('agentdeck:session');
const INBOX_KEY = scopedKey('agentdeck:inbox');
const INBOX_SEEN_KEY = scopedKey('agentdeck:inbox-seen');
const INBOX_CLEARED_KEY = scopedKey('agentdeck:inbox-cleared');
/** Release version this device already announced for the active server. */
const UPDATE_NOTIFIED_KEY = scopedKey('agentdeck:update-notified');
const INBOX_LIMIT = 80;
const MODEL_PREFS_KEY = 'agentdeck:model-prefs';

/** A saved server as the UI sees it (the login itself stays in api/servers). */
export interface SavedServer {
  id: string;
  /** Name the server reported at pairing; '' while never paired. */
  name: string;
  /** API base URL; '' = same origin. */
  base: string;
  paired: boolean;
}

function savedServers(): SavedServer[] {
  return listServers().map((s) => ({ id: s.id, name: s.name, base: s.base, paired: s.token !== null }));
}

/** Label for a saved server: its name, else its address. */
export function serverLabel(server: Pick<SavedServer, 'name' | 'base'>): string {
  return server.name || server.base.replace(/^https?:\/\//i, '') || 'This server';
}

/**
 * Full reload — the one clean way to change servers. The URL loses its hash,
 * so the app opens on the screen the (new) server was last left on, else home.
 */
function reloadApp(): void {
  disconnectSocket();
  window.history.replaceState(null, '', window.location.pathname);
  window.location.reload();
}

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

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** The hash this page load starts on (see startHash); puts it in the URL before anything renders. */
function resolveStartHash(): string {
  const hash = startHash(window.location.hash, readStored(ROUTE_KEY));
  if (hash !== window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  return hash;
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
  /** Counts socket (re)connects — views that follow a live stream reload their state when it changes. */
  socketEpoch: number;
  booted: boolean;
  /** Servers saved on this device (one login each); the app talks to the active one. */
  servers: SavedServer[];
  activeServerId: string;
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
  /** Devices outside the server's network waiting for this one to let them in. */
  pairRequests: PairRequestInfo[];
  /** Agent admin jobs (update/install/login), newest first — live via WS. */
  adminJobs: AdminJob[];
  toasts: Toast[];
  lightbox: LightboxState | null;
  /**
   * Something another app shared (APK share target, PWA share_target), waiting
   * for a chat. `target`: null — the user is still choosing; 'any' — the next
   * chat that opens; otherwise the session it goes to.
   */
  share: (IncomingShare & { target: string | null }) | null;
  modelPrefs: Partial<Record<AgentId, string>>;
  /** Metadata of the latest APK on the server (null = unknown / unreachable). */
  apkInfo: ApkInfo | null;
  /** Server version, latest release and the running update job (null = not fetched / older server). */
  update: UpdateInfo | null;
  /** Subscription usage per agent (null = not fetched yet). */
  usage: AgentUsage[] | null;
  /** Agent shown in the top-left usage button: follows the agent in use (hooks/useUsageTracking), or a manual pick. */
  currentUsageAgent: AgentId;
  /** Whether the full usage sheet is currently open. */
  usageSheetOpen: boolean;
  activitySheetOpen: boolean;
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
  /** The terminal list came from the server at least once (before that, `terminals` is just empty). */
  terminalsLoaded: boolean;
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
  /** Pairs; from outside the server's network it returns the request a paired device has to approve. */
  pair(code: string, deviceName: string): Promise<PairPendingResponse['pending'] | null>;
  /** Log in with the token of a pairing that went through. */
  finishPairing(res: PairResponse): Promise<void>;
  unpair(silent?: boolean): void;
  setServerBase(base: string): void;
  /** Switch to another saved server — reloads the app, nothing of the old one survives. */
  switchServer(id: string): void;
  /** Start pairing an additional server (lands on the pairing screen). */
  addServer(): void;
  /** Forget a saved server and its login on this device. */
  removeServer(id: string): void;
  refreshDevices(): Promise<void>;
  refreshPairRequests(): Promise<void>;
  /** One-shot fetch of GET /api/apk/info (app start, settings screen). */
  refreshApkInfo(): Promise<void>;
  /** Fetch GET /api/update; `force` makes the server ask GitHub again. */
  refreshUpdate(force?: boolean): Promise<void>;
  /** Update the server to the latest release (progress arrives via WS). */
  startUpdate(): Promise<void>;
  /** Fetch GET /api/usage. `silent` (background polling) keeps the old numbers and skips the error toast. */
  refreshUsage(opts?: { silent?: boolean }): Promise<void>;
  /** Switch the active agent shown in the top-left usage circle button. */
  setCurrentUsageAgent(agentId: AgentId): void;
  /** Open or close the full usage details sheet. */
  setUsageSheetOpen(open: boolean): void;
  setActivitySheetOpen(open: boolean): void;
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
  /** Answers a question the session's run waits on (allow / deny a tool call, or pick from its options). */
  answerPermission(sessionId: string, requestId: string, answer: AnswerPermissionRequest): Promise<void>;
  openInIde(sessionId: string): Promise<void>;
  setSessionModel(sessionId: string, model: string | undefined): void;
  /** Optimistic; reverted with a toast when the server rejects it. Applies from the next turn. */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
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
  /** Offers a share to the user (opens the "send to" sheet). */
  offerShare(share: IncomingShare): void;
  aimShare(target: string): void;
  dropShare(): void;
  /** Hands the share to the composer of `sessionId` when it is meant for it — once. */
  takeShare(sessionId: string): IncomingShare | null;
}

type SessionEventPayload = Parameters<ServerToClientEvents['session:event']>[0];

/** Hidden for longer than this, the socket is not trusted any more when the app returns. */
const STALE_SOCKET_MS = 15_000;

let initialized = false;
let socketAttached = false;
let tmpMsgSeq = 0;
/** Per session: which run events the draft from the last snapshot already holds. */
const streamMarks = new Map<string, StreamMark>();
/** Sessions being (re)loaded: their stream events wait here until the snapshot is in. */
const syncing = new Map<string, { queue: SessionEventPayload[]; promise: Promise<void> }>();
let toastSeq = 0;
/** Admin job ids we already toasted a done/error for (WS replays the full job). */
const toastedAdminJobs = new Set<string>();
/** On the desktop Code tab every pane is in view, not only the active terminal. */
function terminalInView(activeId: string | null, id: string): boolean {
  return activeId === id || (desktopLayoutNow() && usePanes.getState().slots.includes(id));
}

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
  // Event routines (commit, CI failure, webhook) have no clock.
  if (schedule.kind !== 'daily' && schedule.kind !== 'weekly') return null;
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

export const useAppStore = create<AppStore>()((set, get, store) => {
  /* --- socket wiring --------------------------------------------------- */

  function attachSocket(): void {
    const socket = connectSocket();
    if (socketAttached) return;
    socketAttached = true;

    socket.on('connect', () => {
      // Whatever was streamed while the socket was down never arrived: other
      // sessions reload when they are opened, the open one right away.
      const open = get().activeSessionId;
      set((st) => ({
        connection: 'online',
        socketEpoch: st.socketEpoch + 1,
        loadedSessions: open && st.loadedSessions[open] ? { [open]: true } : {},
        drafts: open && st.drafts[open] ? { [open]: st.drafts[open] } : {},
      }));
      void get().bootstrap(true);
      void syncInbox();
      resyncActiveSession();
    });
    // Back in front. Android freezes a backgrounded app with the socket still
    // looking connected; after a longer pause it is replaced right away rather
    // than waiting for the heartbeat to notice — the connect above catches up.
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt = Date.now();
        return;
      }
      const sock = getSocket();
      if (!sock) return;
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (!sock.connected || away > STALE_SOCKET_MS) sock.disconnect().connect();
      else resyncActiveSession();
    });
    socket.on('disconnect', (reason) => {
      // Our own reconnect above is back in a moment — no "offline" flash for it.
      if (reason !== 'io client disconnect') set({ connection: 'offline' });
    });
    socket.on('connect_error', () => {
      set({ connection: 'offline' });
    });

    socket.on('session:event', (payload) => {
      const pending = syncing.get(payload.sessionId);
      if (pending) pending.queue.push(payload);
      else applySessionEvent(payload);
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
      set({ terminals, terminalsLoaded: true });
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

    socket.on('update:state', ({ update }) => {
      const before = get().update?.job?.status;
      set({ update });
      if (before === 'running' && update.job?.status === 'error') {
        get().toast('error', update.job.error?.trim() || 'Server update failed');
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

    socket.on('pair:requests', ({ requests }) => {
      set({ pairRequests: requests });
    });

    socket.on('notify', ({ level, text }) => {
      get().toast(level, text);
    });

    socket.on('terminal:attention', ({ id, state }) => {
      set((st) => ({
        terminals: st.terminals.map((t) =>
          t.id === id ? { ...t, attention: true, ...(state ? { attentionState: state } : {}) } : t,
        ),
      }));
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
        (n.terminalId && st.route.name === 'code' && terminalInView(st.activeTerminalId, n.terminalId)));
    if (looking) {
      if (n.terminalId) get().markTerminalSeen(n.terminalId);
      return;
    }
    if (!prefs.notifyKinds[n.kind]) return;
    if (document.visibilityState === 'visible') {
      const state = stateOf(n);
      haptic(state === 'done' ? 'success' : 'warning');
      get().toast(state === 'error' ? 'error' : state === 'limit' || state === 'waiting' ? 'warn' : 'info', `${n.title} — ${n.body}`);
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

  function applySessionEvent({ sessionId, event, run, seq }: SessionEventPayload): void {
    if (isCovered(streamMarks.get(sessionId), run, seq)) return;
    switch (event.type) {
      case 'status':
        applyStatus(sessionId, event.status, event.detail);
        break;
      case 'message':
        appendMessage(sessionId, event.message);
        if (event.message.role !== 'user') finalizeDraft(sessionId, event.message);
        break;
      case 'raw':
        break;
      default:
        set((st) => {
          const before = st.drafts[sessionId];
          const after = reduceDraft(before, event);
          return after && after !== before ? { drafts: { ...st.drafts, [sessionId]: after } } : {};
        });
    }
  }

  /**
   * Loads a session — the whole history the first time, afterwards only what
   * is new — together with the answer of a run in progress. Stream events
   * arriving meanwhile are replayed on top, so nothing is doubled or lost.
   */
  function syncSession(id: string): Promise<void> {
    const running = syncing.get(id);
    if (running) return running.promise;
    const queue: SessionEventPayload[] = [];
    const promise = (async () => {
      try {
        const st = get();
        const after = st.loadedSessions[id] ? lastServerMessageId(st.messagesBySession[id] ?? []) : undefined;
        applySnapshot(id, await api.session(id, after), after);
      } finally {
        syncing.delete(id);
        for (const payload of queue) applySessionEvent(payload);
      }
    })();
    syncing.set(id, { queue, promise });
    return promise;
  }

  function applySnapshot(id: string, detail: SessionDetailResponse, after: string | undefined): void {
    const { session, messages, draft } = detail;
    if (draft) streamMarks.set(id, { run: draft.run, seq: draft.seq });
    else streamMarks.delete(id);
    set((st) => {
      const local = st.messagesBySession[id] ?? [];
      const partial = detail.partial === true;
      // The list this answer continues is gone (session deleted meanwhile): load it whole next time.
      if (partial && !local.some((m) => m.id === after)) {
        const loadedSessions = { ...st.loadedSessions };
        delete loadedSessions[id];
        return { loadedSessions };
      }
      const drafts = { ...st.drafts };
      if (draft) drafts[id] = draftFromSnapshot(draft);
      // Servers before the draft snapshot: keep what was streamed while the run is still going.
      else if (draft === null || (session.status !== 'running' && session.status !== 'queued')) delete drafts[id];
      return {
        sessionsByProject: upsertSessionMap(st.sessionsByProject, session),
        messagesBySession: { ...st.messagesBySession, [id]: mergeHistory(local, messages, partial) },
        loadedSessions: { ...st.loadedSessions, [id]: true },
        drafts,
      };
    });
  }

  /** After a socket gap or the app returning to the front: catch up on the open session. */
  function resyncActiveSession(): void {
    const id = get().activeSessionId;
    if (id && get().loadedSessions[id]) void syncSession(id).catch(() => undefined);
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

  /**
   * Once per page load, after the first sessions and team runs arrived: put
   * back the chat session the user left open, and send a remembered screen
   * whose subject is gone (a deleted team run) to the list it belongs to.
   * A session that no longer exists is forgotten, never opened.
   */
  let viewRestored = false;
  function restoreView(): void {
    if (viewRestored) return;
    viewRestored = true;
    const st = get();
    const sessions = st.activeProjectId ? (st.sessionsByProject[st.activeProjectId] ?? []) : [];
    const stored = readStored(SESSION_KEY);
    const open = validSessionId(stored, sessions.map((s) => s.id));
    if (open && !st.activeSessionId) {
      set({ activeSessionId: open, currentUsageAgent: sessions.find((s) => s.id === open)?.agentId ?? st.currentUsageAgent });
    } else if (stored && !open) {
      writeStored(SESSION_KEY, null);
    }
    const route = validRoute(st.route, { teamRunIds: st.teamRuns.map((r) => r.id) });
    if (route !== st.route) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${routeToHash(route)}`);
      set({ route });
    }
  }

  /* --- store ------------------------------------------------------------ */

  return {
    token: getToken(),
    serverBase: getApiBase(),
    servers: savedServers(),
    activeServerId: getActiveServer().id,
    serverInfo: null,
    connection: 'online',
    socketEpoch: 0,
    booted: false,
    route: parseHash(resolveStartHash()),
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
    pairRequests: [],
    adminJobs: [],
    toasts: [],
    lightbox: null,
    share: null,
    modelPrefs: readJson<Partial<Record<AgentId, string>>>(MODEL_PREFS_KEY, {}),
    apkInfo: null,
    update: null,
    usage: null,
    currentUsageAgent: 'claude',
    usageSheetOpen: false,
    activitySheetOpen: false,
    keyboardOpen: false,
    overlayDepth: 0,
    filesVersion: {},
    fileEvents: [],
    terminals: [],
    terminalsLoaded: false,
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
      // Remember where the user is, per server: the screen and the open chat
      // come back on the next start (see restoreView).
      writeStored(ROUTE_KEY, routeToHash(get().route));
      store.subscribe((st, prev) => {
        if (st.route !== prev.route) writeStored(ROUTE_KEY, routeToHash(get().route));
        if (st.activeSessionId !== prev.activeSessionId) writeStored(SESSION_KEY, get().activeSessionId);
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

        // The restore below needs to know these two arrived, not just that they were asked for.
        const ok = (job: Promise<unknown>) => job.then(() => true, () => false);
        const teamsLoaded = ok(get().fetchTeamRuns());
        const sessionsLoaded = active ? ok(get().refreshSessions(active)) : Promise.resolve(true);
        const jobs: Promise<unknown>[] = [
          // Server identity: a login from before saved servers has no name yet,
          // and after a reload nothing else carries it. Older servers 404 here.
          api
            .server()
            .then((info) => {
              if (getActiveServer().name !== info.name) updateActiveServer({ name: info.name });
              set({ serverInfo: info, servers: savedServers() });
            })
            .catch(() => undefined),
          get().refreshTerminalPresets(),
          get().refreshUpdate(),
          get().refreshDevices(),
          get().refreshPairRequests(),
          teamsLoaded,
          get().refreshTerminals(),
          get().refreshRoutines(),
          get().refreshAccounts(),
          sessionsLoaded,
        ];
        await Promise.allSettled(jobs);
        if ((await teamsLoaded) && (await sessionsLoaded)) restoreView();
      } catch (err) {
        if (!silent) get().toast('error', errorMessage(err));
      }
    },

    async pair(code, deviceName) {
      const res = await api.pair({ code, deviceName });
      if ('pending' in res) return res.pending;
      await get().finishPairing(res);
      return null;
    },

    async finishPairing(res) {
      persistToken(res.token);
      updateActiveServer({ name: res.server.name });
      set({
        token: res.token,
        serverInfo: res.server,
        connection: 'online',
        // The pairing screen writes the address straight to storage.
        serverBase: getApiBase(),
        servers: savedServers(),
      });
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
        servers: savedServers(),
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
        pairRequests: [],
        adminJobs: [],
        overlayDepth: 0,
        filesVersion: {},
        fileEvents: [],
        terminals: [],
        terminalsLoaded: false,
        activeTerminalId: null,
      });
      toastedAdminJobs.clear();
      get().navigate({ name: 'home' });
      if (!silent) get().toast('info', 'Unpaired from server');
    },

    setServerBase(base) {
      persistApiBase(base);
      set({ serverBase: getApiBase(), servers: savedServers() });
      disconnectSocket();
      socketAttached = false;
      if (get().token) {
        attachSocket();
        void get().bootstrap();
      }
    },

    switchServer(id) {
      if (id === get().activeServerId || !activateServer(id)) return;
      reloadApp();
    },

    addServer() {
      addSavedServer();
      reloadApp();
    },

    removeServer(id) {
      const wasActive = id === get().activeServerId;
      removeSavedServer(id);
      if (wasActive) reloadApp();
      else set({ servers: savedServers() });
    },

    async refreshDevices() {
      try {
        set({ devices: await api.devices() });
      } catch {
        /* non-fatal */
      }
    },

    async refreshPairRequests() {
      try {
        set({ pairRequests: await api.pairRequests() });
      } catch {
        /* older server without remote pairing */
      }
    },

    async refreshUpdate(force = false) {
      try {
        const before = get().update;
        const update = await api.update(force);
        set({ update });
        if (before && before.current !== update.current) {
          // The server came back as another version: an update just finished.
          get().toast('info', `Server updated to v${update.current}`);
          void get().refreshApkInfo();
        } else if (update.updateAvailable && update.latest) {
          // Announce each release once per server, not on every app start.
          if (readJson<string>(UPDATE_NOTIFIED_KEY, '') !== update.latest.version) {
            writeJson(UPDATE_NOTIFIED_KEY, update.latest.version);
            get().toast('info', `Server update v${update.latest.version} available — see Settings`);
          }
        }
      } catch (err) {
        // Servers older than this route answer 404 — nothing to show then.
        if (force) get().toast('error', errorMessage(err));
      }
    },

    async startUpdate() {
      try {
        set({ update: await api.startUpdate() });
      } catch (err) {
        get().toast('error', errorMessage(err));
        void get().refreshUpdate();
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

    setActivitySheetOpen(activitySheetOpen) {
      set({ activitySheetOpen });
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
        // A chat of the removed project is not open any more.
        const sessionGone = selectSession(st, st.activeSessionId)?.projectId === id;
        return sessionGone ? { projects, activeProjectId, activeSessionId: null } : { projects, activeProjectId };
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
      await syncSession(id);
      const session = selectSession(get(), id);
      if (session) set({ currentUsageAgent: session.agentId });
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
        streamMarks.delete(id);
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

    async answerPermission(sessionId, requestId, answer) {
      const drop = () =>
        set((st) => {
          const before = st.drafts[sessionId];
          const after = reduceDraft(before, { type: 'permission-resolved', id: requestId, decision: answer.decision });
          return after && after !== before ? { drafts: { ...st.drafts, [sessionId]: after } } : {};
        });
      try {
        await api.answerPermission(sessionId, requestId, answer);
        drop();
      } catch (err) {
        // Answered elsewhere or the run is over: the card has nothing left to ask.
        if (err instanceof ApiError && err.status === 409) drop();
        get().toast('error', errorMessage(err));
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

    async setSessionPermissionMode(sessionId, mode) {
      const before = selectSession(get(), sessionId);
      if (!before || before.permissionMode === mode) return;
      const put = (session: Session) =>
        set((st) => ({ sessionsByProject: upsertSessionMap(st.sessionsByProject, session) }));
      put({ ...before, permissionMode: mode });
      try {
        await api.updateSession(sessionId, { permissionMode: mode });
      } catch (err) {
        const current = selectSession(get(), sessionId);
        if (current) put({ ...current, permissionMode: before.permissionMode });
        get().toast('error', errorMessage(err));
      }
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
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { terminal } = await api.createTerminal({ projectId, cols, rows, ...(launch ?? {}), ...(timeZone ? { timeZone } : {}) });
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
      set((st) => ({
        terminals: st.terminals.map((t) => (t.id === id ? { ...t, attention: false, attentionState: undefined } : t)),
      }));
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
      set({ pushActive: sub !== null || fcmRegistered() });
    },

    async refreshTerminals() {
      const terminals = await api.terminals();
      set((st) => ({
        terminals,
        terminalsLoaded: true,
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

    offerShare(share) {
      set({ share: { ...share, target: null } });
    },

    aimShare(target) {
      set((st) => (st.share ? { share: { ...st.share, target } } : {}));
    },

    dropShare() {
      set({ share: null });
    },

    takeShare(sessionId) {
      const share = get().share;
      if (!share || (share.target !== 'any' && share.target !== sessionId)) return null;
      set({ share: null });
      return { text: share.text, files: share.files };
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
