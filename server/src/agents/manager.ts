/**
 * AgentManager: owns the lifecycle of agent runs.
 *
 * - guards (single active run per session, headless capability)
 * - spawns adapter-built plans via execa (cwd = project path)
 * - splits stdout into lines → adapter parser → normalized AgentEvents
 * - broadcasts live events (numbered per run, text deltas bundled), accumulates
 *   text deltas into one assistant ChatMessage flushed at the end
 * - hands out the answer so far (draftOf) to clients that join mid-run
 * - passes an agent's permission questions to the chat and the answers back
 * - retires a question the CLI can no longer take, and clears open ones when a
 *   run ends, so the chat never keeps waiting on a dead run
 * - stops a run that says nothing for too long (stallWarnMs → note, stallAbortMs
 *   → stop) instead of letting the chat hang on a frozen caret
 * - kills runs on interrupt / maxRunMs (SIGINT → 3s → SIGKILL, process group)
 * - persists queued turns to the data dir, so they resume after a restart
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { ThinkTagSplitter } from '@agentdeck/shared';
import type {
  AgentEvent,
  ChatMessage,
  MessageUsage,
  PermissionRequest,
  PlanItem,
  Project,
  RunRecord,
  Session,
  SessionDraft,
  SessionStatus,
  ThinkPart,
  ToolRecord,
} from '@agentdeck/shared';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentService } from './registry.js';
import { newId, newMessageId } from '../util/ids.js';
import { writeFileAtomic } from '../util/atomicWrite.js';
import { ensureDir } from '../util/paths.js';
import { truncate } from './types.js';
import type { AgentAdapter, PermissionAnswer, PermissionSignal, RunAttachment, RunPlan } from './types.js';

type Child = ReturnType<typeof execa>;

export interface TurnOutcome {
  ok: boolean;
  text: string;
  error?: string;
}

/** `meta` numbers the events of one run — absent for events outside a run. */
export type SessionEventEmitter = (
  sessionId: string,
  event: AgentEvent,
  meta?: { run: string; seq: number },
) => void;

/** Streamed text goes out in bundles this far apart instead of one event per token. */
const DELTA_FLUSH_MS = 40;

/** Turns posted while a run is active wait behind it; a cap keeps one chat from piling up forever. */
const MAX_QUEUED_TURNS = 10;

/** Queued turns survive a restart through this file in the data dir. */
const QUEUED_TURNS_FILE = 'queued-turns.json';
const QUEUED_TURNS_VERSION = 1;

/**
 * A note the manager wants the chat to show above the live answer rides on a
 * `raw` event with this prefix (an empty one clears the note) — the same channel
 * adapters use for caveats. The web store lifts it into the draft.
 */
export const NOTICE_PREFIX = '[agentdeck] ';
export const NOTICE_CLEAR = '[agentdeck]';

export interface StartTurnOptions {
  session: Session;
  project: Project;
  text: string;
  attachments: RunAttachment[];
  model?: string;
  /** Per-turn effort override; falls back to session.thinkingEffort. */
  thinkingEffort?: string;
  source: NonNullable<ChatMessage['source']>;
  /** Per-run override of config.maxRunMs. */
  maxRunMs?: number;
  /** The routine that fired this turn — kept with the run's record. */
  routineId?: string;
}

export type StartGate = { ok: true } | { ok: false; code: string; message: string };

/** A turn waiting in a session's queue until its user message is safely on disk. */
interface QueuedTurn {
  opts: StartTurnOptions;
  /** True once the message (and session changes) are persisted; false when saving failed. */
  ready: Promise<boolean>;
  settle: (ok: boolean) => void;
  /** When the turn was accepted — kept with the persisted copy. */
  queuedAt: number;
}

/** The only part of an attachment worth restoring: the file on disk, not its loaded payload. */
type PersistedAttachment = Pick<RunAttachment, 'path' | 'name' | 'mime' | 'size'>;

/** Serializable form of a queued turn — no Session/Project objects, no credentials. */
interface PersistedQueuedTurn {
  sessionId: string;
  projectId: string;
  text: string;
  attachments: PersistedAttachment[];
  model?: string;
  thinkingEffort?: string;
  source: NonNullable<ChatMessage['source']>;
  maxRunMs?: number;
  queuedAt: number;
}

interface QueuedTurnsFile {
  version: typeof QUEUED_TURNS_VERSION;
  turns: PersistedQueuedTurn[];
}

/** Optional persistence handed to `submitTurn` along with the prepared turn. */
export interface SubmitTurnOptions {
  /** Saved before the run may start, so its history already contains the prompt. */
  userMessage?: ChatMessage;
  /** Session changes (title, model, effort) applied only once the turn was accepted. */
  updateSession?: (session: Session) => void;
}

interface ActiveRun {
  /** Run id — sent with every event and with the draft snapshot. */
  id: string;
  startedAt: number;
  /** Number of events broadcast for this run so far. */
  seq: number;
  /** Text / thinking deltas waiting for the next bundle, in order. */
  pending: ThinkPart[];
  flushTimer?: NodeJS.Timeout;
  sessionId: string;
  session: Session;
  adapter: AgentAdapter;
  plan: RunPlan;
  child: Child;
  timer: NodeJS.Timeout;
  /** Repeating check: no output for too long while the run is supposed to work. */
  watchdog: NodeJS.Timeout;
  /** Last stdout/stderr activity — the stall check measures silence against it. */
  lastActivityAt: number;
  /** The "no output" note went out already and has not been cleared by fresh output. */
  stallWarned: boolean;
  /** The watchdog stopped this run — it reads as a failure, not as a user stop. */
  stalled: boolean;
  /** Visible note shown in the chat while the run looks stalled. */
  notice?: string;
  maxRunMs: number;
  /** Questions the agent waits on, by request id. */
  permissions: Map<string, Extract<PermissionSignal, { kind: 'ask' }>>;
  exited: boolean;
  interrupted: boolean;
  externalId?: string;
  textBuf: string;
  /** Model reasoning, accumulated separately from the answer text. */
  thinkingBuf: string;
  /** Splits inline <think> tags out of the text stream. */
  splitter: ThinkTagSplitter;
  tools: ToolRecord[];
  /** The agent's plan checklist, as last reported (TodoWrite / update_plan). */
  planItems: PlanItem[];
  /** Tool calls still waiting for their result. */
  openTools: Set<ToolRecord>;
  /** A tool ran since the last text — next text starts a new paragraph. */
  needSep: boolean;
  usage?: MessageUsage;
  modelUsed?: string;
  errorDetail?: string;
  stderrTail: string;
  stdoutBuf: string;
}

export class AgentManager {
  private readonly active = new Map<string, ActiveRun>();
  /** Sessions claimed from submission until their run is in `active`; no second run may start meanwhile. */
  private readonly starting = new Set<string>();
  /** Starting sessions whose turn was interrupted before it could spawn (deleted session). */
  private readonly canceledStarts = new Set<string>();
  /** Turns posted during an active run, oldest first, per session. */
  private readonly queues = new Map<string, QueuedTurn[]>();
  /** Serializes queue-file writes so a slow, older snapshot cannot land last. */
  private queueWrites: Promise<void> = Promise.resolve();
  /** Agent detection settled; a restored queue may start now. */
  private resumeReady = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly agents: AgentService,
    private readonly logger: Logger,
    private readonly emit: SessionEventEmitter,
    /** Called with every finished run (activity database). */
    private readonly recordRun: (run: RunRecord) => void = () => undefined,
  ) {
    // Rebuild the queues from disk, but do not start anything: agent detection
    // may still be running. `resumeQueuedTurns()` starts them once it settled.
    this.restoreQueuedTurns();
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.starting.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...new Set([...this.active.keys(), ...this.starting.keys()])];
  }

  /** Turns posted during the active run that still wait for their turn. */
  queuedCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** Questions the run waits on, without building/flushing a full draft. */
  pendingQuestionCount(sessionId: string): number {
    return this.active.get(sessionId)?.permissions.size ?? 0;
  }

  /** Drops queued turns (session deleted, agent gone) without touching the active run. */
  clearQueue(sessionId: string): void {
    if (!this.queues.delete(sessionId)) return;
    // The session is on its way out; a failed write must not block the delete.
    void this.saveQueuedTurns();
  }

  /**
   * Starts the first restored turn of every session whose queue survived a
   * restart. Called once agent detection has settled, so a restored turn does
   * not fail just because its adapter was still being probed. `drainQueue`
   * chains the rest. A turn whose agent is unavailable fails cleanly and the
   * queue moves on.
   */
  resumeQueuedTurns(): void {
    this.resumeReady = true;
    for (const sessionId of [...this.queues.keys()]) {
      const session = this.store.getSession(sessionId);
      if (!session) {
        this.queues.delete(sessionId);
        void this.saveQueuedTurns();
        continue;
      }
      void this.drainQueue(sessionId, session);
    }
  }

  /**
   * Starts a turn now, or parks it behind the active run. The REST layer uses
   * this instead of `startTurn` so posting while the agent works is allowed.
   *
   * The slot is reserved synchronously, before the first await: two requests
   * arriving in the same tick cannot both decide the session is idle. A rejected
   * turn never touches the store — `updateSession`/`userMessage` run only after
   * the capacity check.
   */
  async submitTurn(
    opts: StartTurnOptions,
    submitted: SubmitTurnOptions = {},
  ): Promise<{ queued: boolean; error?: string }> {
    const id = opts.session.id;
    // A queue restored from disk means older turns are still waiting, even
    // though nothing runs yet (detection/resume may not have finished).
    const queuedAhead = (this.queues.get(id)?.length ?? 0) > 0;
    if (!this.active.has(id) && !this.starting.has(id) && !queuedAhead) {
      this.starting.add(id);
      try {
        await this.persistTurn(opts.session, submitted);
        await this.store.saveSession(opts.session);
      } catch (err) {
        this.starting.delete(id);
        throw err;
      }
      void this.runReserved(opts);
      return { queued: false };
    }

    const queue = this.queues.get(id) ?? [];
    if (queue.length >= MAX_QUEUED_TURNS) {
      return { queued: false, error: `Too many queued messages (max ${MAX_QUEUED_TURNS}).` };
    }

    // Reserve the slot synchronously. The entry only becomes runnable once its
    // user message is on disk, so a run cannot read a history that lacks it.
    let settle!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const entry: QueuedTurn = { opts, ready, settle, queuedAt: Date.now() };
    queue.push(entry);
    this.queues.set(id, queue);
    try {
      await this.persistTurn(opts.session, submitted);
      opts.session.queuedCount = queue.length > 0 ? queue.length : undefined;
      await this.store.saveSession(opts.session);
    } catch (err) {
      settle(false);
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (this.queues.get(id) === queue) {
        if (queue.length > 0) opts.session.queuedCount = queue.length;
        else this.queues.delete(id);
      }
      await this.saveQueuedTurns();
      throw err;
    }
    settle(true);
    // Best effort, but awaited: once submit returns, a restart finds the turn.
    await this.saveQueuedTurns();
    // A restored queue starts only after detection settled; before that the
    // new turn waits behind it instead of failing the restored turns early.
    if (queuedAhead && this.resumeReady) void this.drainQueue(id, this.store.getSession(id) ?? opts.session);
    return { queued: true };
  }

  /** Writes the prepared user message and applies deferred session changes. */
  private async persistTurn(session: Session, submitted: SubmitTurnOptions): Promise<void> {
    // The prompt lands first: if writing it fails, the session is untouched.
    if (submitted.userMessage) await this.store.appendMessage(submitted.userMessage);
    submitted.updateSession?.(session);
  }

  /** Runs a turn that already owns the session's `starting` slot. */
  private runReserved(opts: StartTurnOptions): Promise<TurnOutcome> {
    return this.startTurnNow(opts)
      .catch((err) => {
        this.logger.error({ err, session: opts.session.id }, 'startTurn crashed');
        return { ok: false, text: '', error: errorMessage(err) };
      })
      .finally(() => {
        this.starting.delete(opts.session.id);
        this.canceledStarts.delete(opts.session.id);
        void this.drainQueue(opts.session.id, opts.session);
      });
  }

  /** Pops the next queued turn and updates the session's queue badge. */
  private async drainQueue(sessionId: string, session: Session): Promise<void> {
    if (this.active.has(sessionId) || this.starting.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(sessionId);
      if (session.queuedCount !== undefined) {
        session.queuedCount = undefined;
        void this.store.saveSession(session).catch(() => undefined);
      }
      void this.saveQueuedTurns();
      return;
    }
    // Claim the start before waiting for the message, so another turn cannot
    // slip in while persistence finishes.
    this.starting.add(sessionId);
    // The badge belongs on the store's object, so the new run does not save a
    // stale count back over it.
    const fresh = this.store.getSession(sessionId) ?? session;
    fresh.queuedCount = queue && queue.length > 0 ? queue.length : undefined;
    void this.store.saveSession(fresh).catch(() => undefined);
    // Persist the removal before the run starts, so a crash during the run
    // cannot replay this turn on the next boot.
    await this.saveQueuedTurns();

    if (!(await next.ready)) {
      // Saving that turn failed; skip it and let the queue move on.
      this.starting.delete(sessionId);
      void this.drainQueue(sessionId, this.store.getSession(sessionId) ?? fresh);
      return;
    }
    if (this.queues.get(sessionId) !== queue) {
      // The queue was cleared (session deleted) while the message was saved.
      this.starting.delete(sessionId);
      return;
    }
    // Re-read the session: the run that just ended may have learned its resume
    // id, and a model pick made while this turn waited must reach it too.
    const readySession = this.store.getSession(sessionId) ?? fresh;
    next.opts.session = readySession;
    next.opts.model = readySession.model;
    next.opts.session.queuedCount = queue && queue.length > 0 ? queue.length : undefined;
    void this.store.saveSession(next.opts.session).catch(() => undefined);
    void this.runReserved(next.opts);
  }

  private queueFile(): string {
    return path.join(this.config.dataDir, QUEUED_TURNS_FILE);
  }

  /** The serializable snapshot of every session's queue. */
  private snapshotQueuedTurns(): PersistedQueuedTurn[] {
    const turns: PersistedQueuedTurn[] = [];
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        turns.push({
          sessionId: entry.opts.session.id,
          projectId: entry.opts.project.id,
          text: entry.opts.text,
          attachments: entry.opts.attachments.map(({ path: p, name, mime, size }) => ({ path: p, name, mime, size })),
          ...(entry.opts.model !== undefined ? { model: entry.opts.model } : {}),
          ...(entry.opts.thinkingEffort !== undefined ? { thinkingEffort: entry.opts.thinkingEffort } : {}),
          source: entry.opts.source,
          ...(entry.opts.maxRunMs !== undefined ? { maxRunMs: entry.opts.maxRunMs } : {}),
          queuedAt: entry.queuedAt,
        });
      }
    }
    return turns;
  }

  /**
   * Writes the queue file with the current snapshot. Writes are chained so an
   * older snapshot cannot land after a newer one; a failure is logged and never
   * propagates (chat must keep working even when this best-effort file fails).
   */
  private saveQueuedTurns(): Promise<void> {
    const payload: QueuedTurnsFile = { version: QUEUED_TURNS_VERSION, turns: this.snapshotQueuedTurns() };
    const write = this.queueWrites.then(() =>
      writeFileAtomic(this.queueFile(), JSON.stringify(payload, null, 2), 0o600),
    );
    this.queueWrites = write.catch((err) => {
      this.logger.warn({ err, file: this.queueFile() }, 'could not persist queued turns');
    });
    return this.queueWrites;
  }

  /**
   * Rebuilds in-memory queues from the last queue file. Entries whose session
   * or project is gone are dropped. Nothing starts here — `resumeQueuedTurns()`
   * does that once agent detection has settled.
   */
  private restoreQueuedTurns(): void {
    const file = this.queueFile();
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err, file }, 'could not read queued turns');
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn({ err, file }, 'ignoring unreadable queued turns file');
      return;
    }
    if (!isRecord(parsed) || parsed.version !== QUEUED_TURNS_VERSION || !Array.isArray(parsed.turns)) {
      this.logger.warn({ file }, 'ignoring queued turns file with an unknown shape');
      return;
    }

    const restored = new Map<string, QueuedTurn[]>();
    let dropped = 0;
    for (const value of parsed.turns) {
      const turn = parsePersistedTurn(value);
      if (!turn) {
        dropped += 1;
        continue;
      }
      const session = this.store.getSession(turn.sessionId);
      const project = this.store.getProject(turn.projectId);
      // A deleted session/project (or a session moved to another project) no
      // longer has a place to run: its user message stays in history.
      if (!session || !project || session.projectId !== project.id) {
        dropped += 1;
        continue;
      }
      const queue = restored.get(session.id) ?? [];
      if (queue.length >= MAX_QUEUED_TURNS) {
        dropped += 1;
        continue;
      }
      queue.push({
        opts: {
          session,
          project,
          text: turn.text,
          attachments: turn.attachments,
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...(turn.thinkingEffort !== undefined ? { thinkingEffort: turn.thinkingEffort } : {}),
          source: turn.source,
          ...(turn.maxRunMs !== undefined ? { maxRunMs: turn.maxRunMs } : {}),
        },
        // The user message was persisted before the queued turn was accepted;
        // there is nothing left to wait for.
        ready: Promise.resolve(true),
        settle: () => undefined,
        queuedAt: turn.queuedAt,
      });
      restored.set(session.id, queue);
    }

    for (const [sessionId, queue] of restored) {
      this.queues.set(sessionId, queue);
      const session = this.store.getSession(sessionId);
      if (!session) continue;
      session.queuedCount = queue.length;
      void this.store.saveSession(session).catch((err) => {
        this.logger.warn({ err, session: sessionId }, 'could not save the restored queue count');
      });
    }
    if (restored.size > 0 || dropped > 0) {
      const turns = [...restored.values()].reduce((n, queue) => n + queue.length, 0);
      this.logger.info({ sessions: restored.size, turns, dropped }, 'restored queued turns');
    }
  }

  /** The answer of the active run so far; undefined when nothing is running. */
  draftOf(sessionId: string): SessionDraft | undefined {
    const run = this.active.get(sessionId);
    if (!run) return undefined;
    // Waiting deltas go out first, so `seq` covers exactly what the snapshot holds.
    this.flushDeltas(run);
    return {
      run: run.id,
      seq: run.seq,
      text: run.textBuf,
      ...(run.thinkingBuf.trim() ? { thinking: run.thinkingBuf } : {}),
      tools: run.tools.map((t) => ({
        tool: t.tool,
        state: run.openTools.has(t) ? ('running' as const) : t.ok ? ('done' as const) : ('error' as const),
        ...(t.summary ? { summary: t.summary } : {}),
        ...(t.result ? { result: t.result } : {}),
      })),
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.planItems.length ? { plan: run.planItems } : {}),
      ...(run.notice ? { notice: run.notice } : {}),
      ...(run.permissions.size ? { permissions: [...run.permissions.values()].map((p) => p.request) } : {}),
    };
  }

  /** Questions of the session's run still waiting for the user. */
  pendingPermissions(sessionId: string): PermissionRequest[] {
    const run = this.active.get(sessionId);
    return run ? [...run.permissions.values()].map((p) => p.request) : [];
  }

  /**
   * Hands the user's answer to the waiting agent. False when that question is
   * gone (answered from another device, withdrawn, run over).
   */
  async answerPermission(sessionId: string, requestId: string, answer: PermissionAnswer): Promise<boolean> {
    const run = this.active.get(sessionId);
    const asked = run?.permissions.get(requestId);
    if (!run || !asked || run.exited) return false;
    // The CLI is gone or closed its stdin: retire the question instead of
    // leaving the chat waiting on an answer nobody can take anymore.
    if (!run.child.stdin?.writable) {
      run.permissions.delete(requestId);
      this.send(run, { type: 'permission-resolved', id: requestId, decision: 'deny' });
      return false;
    }
    run.permissions.delete(requestId);
    // The answer is fresh activity — the agent is about to work again.
    this.markActivity(run);
    const { line, permissionMode } = asked.answer(answer);
    run.child.stdin.write(line + '\n');
    this.send(run, { type: 'permission-resolved', id: requestId, decision: answer.decision });
    if (run.permissions.size === 0) this.armTimer(run);
    if (permissionMode && run.session.permissionMode !== permissionMode) {
      run.session.permissionMode = permissionMode;
      await this.store.saveSession(run.session);
    }
    return true;
  }

  /** Synchronous pre-flight used by the REST layer to return proper 409s. */
  canStart(session: Session): StartGate {
    if (this.active.has(session.id) || this.starting.has(session.id)) {
      return { ok: false, code: 'RUN_ACTIVE', message: 'A run is already active in this session.' };
    }
    const info = this.agents.infoOf(session.agentId);
    if (!info || !info.available) {
      const reason = info?.reason ?? 'not configured';
      return { ok: false, code: 'AGENT_UNAVAILABLE', message: `${info?.label ?? session.agentId} is not available: ${reason}` };
    }
    return { ok: true };
  }

  async startTurn(opts: StartTurnOptions): Promise<TurnOutcome> {
    const { session } = opts;
    // Claim the session before the first await. Two concurrent direct callers
    // (bridge, routines, team) must not spawn two processes either.
    if (this.active.has(session.id) || this.starting.has(session.id)) {
      return { ok: false, text: '', error: 'A run is already active in this session.' };
    }
    this.starting.add(session.id);
    return this.runReserved(opts);
  }

  private async startTurnNow(opts: StartTurnOptions): Promise<TurnOutcome> {
    const { session, project } = opts;
    const existing = this.active.get(session.id);
    if (existing) {
      return { ok: false, text: '', error: 'A run is already active in this session.' };
    }
    const adapter = this.agents.get(session.agentId);
    const info = this.agents.infoOf(session.agentId);
    if (!adapter || !info) {
      return this.failSession(session, `Agent ${session.agentId} is not configured.`);
    }
    if (!info.available) {
      return this.failSession(session, `${info.label} is not available: ${info.reason ?? 'unknown reason'}`);
    }
    if (!adapter.capabilities().headless) {
      await this.store.appendMessage(this.ideSystemMessage(session, info.label));
      return {
        ok: false,
        text: '',
        error: `${info.label} runs in IDE mode only — see the system message in this session.`,
      };
    }

    const attachments = [...opts.attachments];
    for (const att of attachments) {
      if (att.mime.startsWith('image/')) {
        try {
          att.base64 = (await fsp.readFile(att.path)).toString('base64');
        } catch (err) {
          this.logger.warn({ err, path: att.path }, 'failed to read image attachment');
        }
      }
    }

    const model = opts.model ?? session.model;
    const thinkingEffort = opts.thinkingEffort ?? session.thinkingEffort;
    const resumeId = adapter.supportsResume ? session.externalSessionId : undefined;
    let plan: RunPlan;
    try {
      plan = adapter.buildRun({
        session,
        project,
        text: opts.text,
        attachments,
        model,
        thinkingEffort,
        permissionMode: session.permissionMode,
        resumeId,
        // Only the chat has someone to ask; routines, team steps and delegated runs go unattended.
        interactive: opts.source === 'app',
      });
    } catch (err) {
      return this.failSession(session, `Failed to build ${info.label} run: ${errorMessage(err)}`);
    }

    session.lastError = undefined;
    session.status = 'queued';
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'queued' });

    await ensureDir(project.path);

    // Deleted / interrupted while it still held the `starting` reservation: no child.
    if (this.canceledStarts.has(session.id)) {
      await this.markStartingCanceled(session);
      return { ok: false, text: '', error: 'Run canceled before it started.' };
    }

    // Account profile env (multi-account switching) wins over adapter env.
    const accountEnv = session.accountId ? this.store.getAccount(session.accountId)?.env : undefined;

    let child: Child;
    try {
      child = execa(plan.command, plan.args, {
        cwd: project.path,
        env: { ...process.env, ...(plan.env ?? {}), ...(accountEnv ?? {}) },
        stdin: plan.stdinPayloads ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false,
        reject: false,
        detached: true,
        cleanup: false,
      });
    } catch (err) {
      return this.failSession(session, `Failed to spawn ${plan.command}: ${errorMessage(err)}`);
    }

    const run: ActiveRun = {
      id: newId('run'),
      startedAt: Date.now(),
      seq: 0,
      pending: [],
      sessionId: session.id,
      session,
      adapter,
      plan,
      child,
      timer: setTimeout(() => undefined, 0), // armed below
      watchdog: setTimeout(() => undefined, 0), // armed below
      lastActivityAt: Date.now(),
      stallWarned: false,
      stalled: false,
      maxRunMs: opts.maxRunMs ?? this.config.maxRunMs,
      permissions: new Map(),
      exited: false,
      interrupted: false,
      textBuf: '',
      thinkingBuf: '',
      splitter: new ThinkTagSplitter(),
      tools: [],
      planItems: [],
      openTools: new Set(),
      needSep: false,
      stderrTail: '',
      stdoutBuf: '',
    };
    // Interrupted during the spawn itself: take the child down instead of tracking it.
    if (this.canceledStarts.has(session.id)) {
      killTree(child.pid, 'SIGKILL');
      await this.markStartingCanceled(session);
      return { ok: false, text: '', error: 'Run canceled before it started.' };
    }
    this.active.set(session.id, run);
    // The CLI's own default (OpenCode reports it) is what a turn with no pick
    // actually runs, so the message and the activity record can name it.
    run.modelUsed = model ?? info.defaultModel?.id;

    this.armTimer(run);
    this.armWatchdog(run);

    if (plan.notice) {
      this.send(run, { type: 'raw', line: `${NOTICE_PREFIX}${plan.notice}` });
    }

    if (child.stdin && plan.stdinPayloads) {
      for (const payload of plan.stdinPayloads) {
        child.stdin.write(payload + '\n');
      }
      // A run that asks keeps stdin open for the answers until its turn ends.
      if (!plan.permissions) child.stdin.end();
      else child.stdin.on('error', () => undefined); // the CLI may exit before an answer lands
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdoutChunk(run, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      run.stderrTail = (run.stderrTail + chunk).slice(-4000);
      this.markActivity(run);
    });

    session.status = 'running';
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'running' });

    let exitCode: number | undefined;
    let failed = false;
    try {
      const result = await child;
      exitCode = result.exitCode;
      failed = result.failed === true;
    } catch (err) {
      failed = true;
      run.stderrTail = (run.stderrTail + errorMessage(err)).slice(-4000);
    }

    // A last line without a newline still counts.
    if (run.stdoutBuf.trim()) this.handleLine(run, run.stdoutBuf);
    run.stdoutBuf = '';
    run.exited = true;
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    // Whatever the agent still waited on can no longer be answered — retire the
    // cards so no chat keeps showing "waiting for you" after the run is over.
    const abandoned = run.permissions.size > 0;
    for (const id of [...run.permissions.keys()]) {
      run.permissions.delete(id);
      this.send(run, { type: 'permission-resolved', id, decision: 'deny' });
    }
    this.active.delete(session.id);

    // flush() hands these to the message and clears them.
    const usage = run.usage;
    const toolCalls = run.tools.length;
    const text = await this.flush(run);

    let status: SessionStatus;
    let error: string | undefined;
    if (run.stalled) {
      status = 'error';
      error = run.errorDetail ?? 'The run was stopped after going quiet.';
    } else if (run.interrupted) {
      status = 'stopped';
      error = run.errorDetail ?? 'Run interrupted';
    } else if (abandoned) {
      status = 'error';
      error = run.errorDetail ?? `${info.label} ended while waiting for your answer.`;
    } else if (failed || exitCode !== 0 || run.errorDetail) {
      status = 'error';
      const tail = run.stderrTail.trim();
      const raw = run.errorDetail
        ?? (tail
          ? `${info.label} exited with code ${exitCode ?? 'signal'}: ${truncate(tail, 500)}`
          : `${info.label} exited with code ${exitCode ?? 'unknown'}`);
      // Actionable hint for the one recurring zcode setup gap.
      error = /select a model before continuing/i.test(raw)
        ? `${raw}\n\n→ Run \`zcode login zai\` once on this machine (opens the browser), then retry.`
        : raw;
    } else {
      status = 'idle';
    }

    if (run.externalId) session.externalSessionId = run.externalId;
    session.status = status;
    session.lastError = status === 'error' ? error : undefined;
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status });

    this.recordRun({
      id: run.id,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      agentId: session.agentId,
      ...((run.modelUsed ?? model) ? { model: run.modelUsed ?? model } : {}),
      projectId: project.id,
      projectName: project.name,
      sessionId: session.id,
      ...(opts.routineId ? { routineId: opts.routineId } : {}),
      source: opts.source,
      status: status === 'idle' ? 'ok' : status === 'stopped' ? 'stopped' : 'error',
      ...(status !== 'idle' && error ? { error } : {}),
      title: opts.text,
      ...(text ? { summary: text } : {}),
      ...usage,
      toolCalls,
    });

    this.logger.info({ session: session.id, agent: session.agentId, status, exitCode }, 'run finished');
    return { ok: status !== 'error', text, error };
  }

  /** A run canceled before it owned `active` must not leave the session "queued". */
  private async markStartingCanceled(session: Session): Promise<void> {
    // Deleted sessions are gone from the store; never recreate their meta.
    if (!this.store.getSession(session.id)) return;
    session.status = 'stopped';
    session.lastError = undefined;
    await this.store.saveSession(session).catch(() => undefined);
    this.emit(session.id, { type: 'status', status: 'stopped' });
  }

  /** SIGINT (graceful) now, SIGKILL after 3s if still alive. Returns false when nothing active. */
  interrupt(sessionId: string, reason?: string): boolean {
    const run = this.active.get(sessionId);
    if (!run) {
      // Still in the `starting` reservation: stop it before it can spawn a child.
      if (!this.starting.has(sessionId)) return false;
      this.canceledStarts.add(sessionId);
      this.logger.info({ session: sessionId }, 'interrupting run before it starts');
      return true;
    }
    run.interrupted = true;
    if (reason && !run.errorDetail) run.errorDetail = reason;
    killTree(run.child.pid, 'SIGINT');
    const killTimer = setTimeout(() => {
      if (!run.exited) {
        killTree(run.child.pid, 'SIGKILL');
        try {
          run.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 3000);
    killTimer.unref?.();
    this.logger.info({ session: sessionId }, 'interrupting run');
    return true;
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.interrupt(id, 'Server shutting down');
  }

  // -------------------------------------------------------------------------

  private onStdoutChunk(run: ActiveRun, chunk: string): void {
    if (run.exited) return;
    this.markActivity(run);
    run.stdoutBuf += chunk;
    for (;;) {
      const idx = run.stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = run.stdoutBuf.slice(0, idx);
      run.stdoutBuf = run.stdoutBuf.slice(idx + 1);
      this.handleLine(run, line);
    }
  }

  /** (Re)starts the run's time limit. */
  private armTimer(run: ActiveRun): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      this.interrupt(run.sessionId, `Run exceeded the ${Math.round(run.maxRunMs / 1000)}s limit`);
    }, run.maxRunMs);
    run.timer.unref?.();
  }

  /** Starts the repeating stall check; its cadence follows the warn threshold. */
  private armWatchdog(run: ActiveRun): void {
    const tick = Math.max(25, Math.min(15_000, Math.floor(this.config.stallWarnMs / 2)));
    clearInterval(run.watchdog);
    run.watchdog = setInterval(() => this.checkStall(run), tick);
    run.watchdog.unref?.();
  }

  /** Notes fresh output; a visible stall note goes away with it. */
  private markActivity(run: ActiveRun): void {
    // Once the watchdog gave up on the run, the note stays with the failure.
    if (run.stalled) return;
    run.lastActivityAt = Date.now();
    if (run.stallWarned) {
      run.stallWarned = false;
      if (run.notice) {
        run.notice = undefined;
        this.send(run, { type: 'raw', line: NOTICE_CLEAR });
      }
    }
  }

  /**
   * A run that says nothing for long is either thinking or stuck. Warn once on
   * the way (so the chat is not just a frozen caret), and stop it after the
   * abort threshold — a hung run must not hold the session forever.
   */
  private checkStall(run: ActiveRun): void {
    if (run.exited || run.interrupted || this.active.get(run.sessionId) !== run) return;
    // Waiting on the user's answer is not a stall.
    if (run.permissions.size > 0) {
      run.lastActivityAt = Date.now();
      return;
    }
    const silent = Date.now() - run.lastActivityAt;
    if (silent >= this.config.stallAbortMs) {
      const reason = `No output for ${formatDuration(silent)} — the agent looked stuck, so the run was stopped.`;
      run.stalled = true;
      this.setNotice(run, reason);
      this.interrupt(run.sessionId, reason);
      return;
    }
    if (silent >= this.config.stallWarnMs && !run.stallWarned) {
      this.setNotice(run, `No output for ${formatDuration(silent)} — the agent may be thinking or waiting.`);
    }
  }

  /** Shows a note above the live answer (it also rides in the draft snapshot). */
  private setNotice(run: ActiveRun, text: string): void {
    if (run.notice === text) return;
    run.notice = text;
    run.stallWarned = true;
    this.send(run, { type: 'raw', line: `${NOTICE_PREFIX}${text}` });
  }

  /** True when the line was a permission exchange and is not agent output. */
  private handlePermissionLine(run: ActiveRun, line: string): boolean {
    const signal = run.plan.permissions?.(line);
    if (!signal) return false;
    switch (signal.kind) {
      case 'ask':
        run.permissions.set(signal.request.id, signal);
        // Waiting for the user is not running: the limit starts over with the answer.
        clearTimeout(run.timer);
        this.send(run, { type: 'permission-request', request: signal.request });
        return true;
      case 'cancel':
        if (run.permissions.delete(signal.id)) {
          this.send(run, { type: 'permission-resolved', id: signal.id, decision: 'deny' });
          if (run.permissions.size === 0) this.armTimer(run);
        }
        return true;
      case 'reply':
        if (run.child.stdin?.writable) run.child.stdin.write(signal.line + '\n');
        return true;
      case 'end':
        // The line itself still carries usage and the result for the parser.
        if (run.child.stdin?.writable) run.child.stdin.end();
        return false;
    }
  }

  private handleLine(run: ActiveRun, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.handlePermissionLine(run, trimmed)) return;
    const externalId = run.adapter.externalSessionIdOf?.(trimmed);
    if (externalId && externalId !== run.externalId) {
      run.externalId = externalId;
    }
    try {
      run.plan.parse(trimmed, (event) => this.onAgentEvent(run, event));
    } catch (err) {
      this.logger.warn({ err, session: run.sessionId }, 'adapter parse error');
      this.send(run, { type: 'raw', line: trimmed });
    }
  }

  private onAgentEvent(run: ActiveRun, event: AgentEvent): void {
    switch (event.type) {
      case 'text-delta':
        this.onText(run, run.splitter.push(event.text));
        return;
      case 'thinking-delta':
        run.thinkingBuf += event.text;
        this.queueDelta(run, 'thinking', event.text);
        return;
      case 'tool-use':
        {
          const rec: ToolRecord = { tool: event.tool, ok: true, ...(event.summary ? { summary: event.summary } : {}) };
          run.tools.push(rec);
          run.openTools.add(rec);
        }
        run.needSep = true;
        break;
      case 'plan':
        // Each update replaces the list; the chat renders it as a checklist.
        run.planItems = event.items;
        break;
      case 'tool-result': {
        const open = [...run.openTools].find((t) => t.tool === event.tool);
        if (open) {
          open.ok = event.ok;
          if (event.summary) open.summary = event.summary;
          if (event.result) open.result = event.result;
          run.openTools.delete(open);
        } else {
          run.tools.push({
            tool: event.tool,
            ok: event.ok,
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.result ? { result: event.result } : {}),
          });
        }
        break;
      }
      case 'usage': {
        run.usage = {
          inputTokens: event.inputTokens ?? run.usage?.inputTokens,
          outputTokens: event.outputTokens ?? run.usage?.outputTokens,
          cacheReadTokens: event.cacheReadTokens ?? run.usage?.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens ?? run.usage?.cacheWriteTokens,
          costUsd: event.costUsd ?? run.usage?.costUsd,
        };
        if (event.model) run.modelUsed = event.model;
        break;
      }
      case 'status':
        // A run the user stopped did not fail, whatever the CLI reports on its way out.
        if (event.status === 'error' && run.interrupted) return;
        if (event.status === 'error' && event.detail && !run.errorDetail) {
          run.errorDetail = event.detail;
        }
        break;
      default:
        break; // tool-*/raw/message events are broadcast-only
    }
    this.send(run, event);
  }

  /** Broadcasts one run event. Waiting text goes out first, so the order stays as produced. */
  private send(run: ActiveRun, event: AgentEvent): void {
    this.flushDeltas(run);
    run.seq += 1;
    this.emit(run.sessionId, event, { run: run.id, seq: run.seq });
  }

  /** Collects streamed text; it is broadcast in bundles (DELTA_FLUSH_MS) rather than per token. */
  private queueDelta(run: ActiveRun, kind: ThinkPart['kind'], text: string): void {
    if (!text) return;
    const last = run.pending[run.pending.length - 1];
    if (last && last.kind === kind) last.text += text;
    else run.pending.push({ kind, text });
    if (!run.flushTimer) {
      run.flushTimer = setTimeout(() => this.flushDeltas(run), DELTA_FLUSH_MS);
      run.flushTimer.unref?.();
    }
  }

  private flushDeltas(run: ActiveRun): void {
    if (run.flushTimer) {
      clearTimeout(run.flushTimer);
      run.flushTimer = undefined;
    }
    if (run.pending.length === 0) return;
    const parts = run.pending;
    run.pending = [];
    for (const part of parts) {
      run.seq += 1;
      this.emit(
        run.sessionId,
        { type: part.kind === 'thinking' ? 'thinking-delta' : 'text-delta', text: part.text },
        { run: run.id, seq: run.seq },
      );
    }
  }

  /** Routes split text/thinking parts into the buffers and queues them for broadcast. */
  private onText(run: ActiveRun, parts: ThinkPart[]): void {
    for (const part of parts) {
      if (part.kind === 'thinking') {
        run.thinkingBuf += part.text;
        this.queueDelta(run, 'thinking', part.text);
        continue;
      }
      let text = part.text;
      if (run.needSep && run.textBuf.trim() && !/\n\s*$/.test(run.textBuf) && text.trim()) text = '\n\n' + text;
      if (text.trim()) run.needSep = false;
      run.textBuf += text;
      this.queueDelta(run, 'text', text);
    }
  }

  /** Persists buffered text+thinking as one assistant ChatMessage and clears the buffers. */
  private async flush(run: ActiveRun): Promise<string> {
    this.onText(run, run.splitter.end());
    // Nothing may trail the finished message — this also stops the bundle timer.
    this.flushDeltas(run);
    const text = run.textBuf;
    const thinking = run.thinkingBuf;
    const tools = run.tools;
    run.tools = [];
    if (!text.trim() && !thinking.trim() && tools.length === 0 && run.planItems.length === 0) {
      run.textBuf = '';
      run.thinkingBuf = '';
      run.usage = undefined;
      return '';
    }
    const message: ChatMessage = {
      id: newMessageId(),
      sessionId: run.sessionId,
      role: 'assistant',
      agentId: run.session.agentId,
      ...(run.modelUsed ? { model: run.modelUsed } : run.session.model ? { model: run.session.model } : {}),
      text,
      ...(thinking.trim() ? { thinking } : {}),
      ...(tools.length ? { tools } : {}),
      ...(run.planItems.length ? { plan: [...run.planItems] } : {}),
      attachments: [],
      ts: Date.now(),
      ...(run.usage ? { usage: run.usage } : {}),
    };
    run.textBuf = '';
    run.thinkingBuf = '';
    run.usage = undefined;
    await this.store.appendMessage(message);
    return text;
  }

  private async failSession(session: Session, reason: string): Promise<TurnOutcome> {
    session.status = 'error';
    session.lastError = reason;
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'error', detail: reason });
    return { ok: false, text: '', error: reason };
  }

  private ideSystemMessage(session: Session, label: string): ChatMessage {
    const text = [
      `${label} runs in IDE mode on this machine — it cannot be driven headlessly from the app.`,
      '',
      'How to work with it:',
      `• Open the project in the IDE: POST /api/sessions/${session.id}/ide (the "Open in IDE" action).`,
      '• Delegate tasks across agents via the MCP bridge: register the `agentdeck-mcp` binary',
      '  (shipped with this server) as an MCP server inside the IDE agent. It exposes',
      '  `agentdeck_list_agents`, `agentdeck_delegate` and `agentdeck_project_files`, so the',
      '  IDE agent can hand work to headless agents (Claude Code, Codex) on this machine.',
      '',
      'Your message is saved above and stays in this session’s history.',
    ].join('\n');
    return {
      id: newMessageId(),
      sessionId: session.id,
      role: 'system',
      agentId: session.agentId,
      text,
      attachments: [],
      ts: Date.now(),
    };
  }
}

const TURN_SOURCES = new Set<string>(['app', 'mcp', 'team', 'routine']);

function isTurnSource(value: unknown): value is NonNullable<ChatMessage['source']> {
  return typeof value === 'string' && TURN_SOURCES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersistedAttachment(value: unknown): PersistedAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const { path: file, name, mime, size } = value;
  if (typeof file !== 'string' || !file) return undefined;
  if (typeof name !== 'string' || typeof mime !== 'string') return undefined;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  return { path: file, name, mime, size };
}

/** Validates one entry from the queue file; anything unusable is dropped. */
function parsePersistedTurn(value: unknown): PersistedQueuedTurn | undefined {
  if (!isRecord(value)) return undefined;
  const { sessionId, projectId, text, attachments, model, thinkingEffort, source, maxRunMs, queuedAt } = value;
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  if (typeof projectId !== 'string' || !projectId) return undefined;
  if (typeof text !== 'string') return undefined;
  if (!Array.isArray(attachments)) return undefined;
  const parsedAttachments: PersistedAttachment[] = [];
  for (const attachment of attachments) {
    const parsed = parsePersistedAttachment(attachment);
    if (!parsed) return undefined;
    parsedAttachments.push(parsed);
  }
  if (!text.trim() && parsedAttachments.length === 0) return undefined;
  const turn: PersistedQueuedTurn = {
    sessionId,
    projectId,
    text,
    attachments: parsedAttachments,
    // An unknown source (older/hand-edited file) still runs, as a chat turn.
    source: isTurnSource(source) ? source : 'app',
    queuedAt: typeof queuedAt === 'number' && Number.isFinite(queuedAt) ? queuedAt : Date.now(),
  };
  if (typeof model === 'string') turn.model = model;
  if (typeof thinkingEffort === 'string') turn.thinkingEffort = thinkingEffort;
  if (typeof maxRunMs === 'number' && Number.isFinite(maxRunMs) && maxRunMs > 0) turn.maxRunMs = maxRunMs;
  return turn;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  // The child was spawned detached → it leads its own process group.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // fall back to the direct pid
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** "12s", "2m", "1h 05m" for a stretch of silence. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
