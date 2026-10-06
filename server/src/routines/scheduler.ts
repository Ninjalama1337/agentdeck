/**
 * RoutineScheduler: agents on recurring jobs (BridgeMind routines).
 *
 * Ticks every 30 s, computes the next fire time per routine (pure function,
 * unit-tested) and starts a normal agent turn in the routine's persistent
 * session. A fire is skipped while that session still has an active run.
 *
 * Event routines fire on a change instead of a clock: the tick looks at the
 * project's HEAD (`commit`) or its newest finished CI run (`ci-failed`) and
 * compares with what the routine saw last; `webhook` routines are fired by
 * the hook route. What set the run off is appended to the prompt.
 */
import { execa } from 'execa';
import type { Routine, RoutineSchedule, RoutineTrigger } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentManager } from '../agents/manager.js';
import type { ChatMessage, Session } from '@agentdeck/shared';
import { newMessageId } from '../util/ids.js';

const TICK_MS = 30_000;
/** GitHub is asked about CI runs this often per routine, not on every tick. */
const CI_POLL_MS = 120_000;
const CONTEXT_MAX = 4000;

/** The checked-out commit of a project. */
export interface HeadInfo {
  hash: string;
  subject: string;
}

/** The newest finished CI run of a project. */
export interface CiRun {
  id: string;
  failed: boolean;
  name: string;
  branch?: string;
  url?: string;
}

async function gitHead(projectPath: string): Promise<HeadInfo | undefined> {
  const res = await execa('git', ['-C', projectPath, 'log', '-1', '--format=%H%n%s'], { reject: false, timeout: 10_000 });
  if (res.exitCode !== 0) return undefined;
  const [hash, ...subject] = res.stdout.split('\n');
  return hash ? { hash, subject: subject.join(' ').trim() } : undefined;
}

async function ghLatestRun(projectPath: string): Promise<CiRun | undefined> {
  const res = await execa(
    'gh',
    ['run', 'list', '--status', 'completed', '--limit', '1', '--json', 'databaseId,conclusion,name,displayTitle,headBranch,url'],
    { cwd: projectPath, reject: false, timeout: 20_000 },
  );
  if (res.exitCode !== 0) return undefined;
  try {
    const run = (JSON.parse(res.stdout) as Record<string, unknown>[])[0];
    if (!run || run.databaseId === undefined) return undefined;
    const text = (key: string): string | undefined => (typeof run[key] === 'string' && run[key] ? (run[key] as string) : undefined);
    return {
      id: String(run.databaseId),
      failed: run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure',
      name: [text('name'), text('displayTitle')].filter(Boolean).join(' — ') || 'CI run',
      ...(text('headBranch') ? { branch: text('headBranch') } : {}),
      ...(text('url') ? { url: text('url') } : {}),
    };
  } catch {
    return undefined;
  }
}

/** True for routines that fire on an event rather than a clock. */
export function isEventSchedule(schedule: RoutineSchedule): boolean {
  return schedule.kind === 'commit' || schedule.kind === 'ci-failed' || schedule.kind === 'webhook';
}

function timestamp24h(ts = Date.now()): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
}

export interface SchedulerDeps {
  store: Store;
  manager: AgentManager;
  log: Logger;
  /** Overrides for tests: how HEAD and the newest CI run are read. */
  headOf?: (projectPath: string) => Promise<HeadInfo | undefined>;
  latestCiRun?: (projectPath: string) => Promise<CiRun | undefined>;
}

/** Pure: when this routine fires next (ms epoch), or null when unknown. */
export function nextRunAt(routine: Routine, now = Date.now()): number | null {
  const anchor = routine.lastRunAt ?? routine.createdAt;
  const schedule = routine.schedule;
  // Event routines have no clock.
  if (schedule.kind === 'commit' || schedule.kind === 'ci-failed' || schedule.kind === 'webhook') return null;
  if (schedule.kind === 'interval') {
    return anchor + schedule.minutes * 60_000;
  }
  const time = parseHhMm(schedule.time) ?? { h: 9, m: 0 };
  if (schedule.kind === 'daily') {
    return nextDailyAt(anchor, time, now);
  }
  // weekly
  const next = nextDailyAt(anchor, time, now);
  // Walk forward day by day until the weekday matches (≤ 7 iterations).
  for (let i = 0; i < 8; i++) {
    const candidate = next + i * 86_400_000;
    if (new Date(candidate).getDay() === schedule.weekday) {
      // If the daily candidate overshoots into the next week, go back only
      // when it still lies in the future.
      if (candidate > now || candidate === next) return candidate;
    }
  }
  return next + 7 * 86_400_000;
}

function nextDailyAt(anchor: number, time: { h: number; m: number }, now: number): number {
  const base = new Date(anchor);
  base.setHours(time.h, time.m, 0, 0);
  let candidate = base.getTime();
  if (candidate <= Math.max(anchor, now - TICK_MS)) candidate += 86_400_000;
  return candidate;
}

export function parseHhMm(value: string): { h: number; m: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

export function validateSchedule(schedule: RoutineSchedule): string | null {
  if (schedule.kind === 'commit' || schedule.kind === 'ci-failed' || schedule.kind === 'webhook') return null;
  if (schedule.kind === 'interval') {
    if (!Number.isInteger(schedule.minutes) || schedule.minutes < 1 || schedule.minutes > 20160) {
      return 'interval minutes must be 1..20160';
    }
    return null;
  }
  if (!parseHhMm(schedule.time)) return 'time must be HH:MM (server local time)';
  if (schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)) {
    return 'weekday must be 0 (Sunday) .. 6 (Saturday)';
  }
  return null;
}

export class RoutineScheduler {
  private timer: NodeJS.Timeout | undefined;
  private firing = new Set<string>();
  /** When each `ci-failed` routine last asked GitHub. */
  private ciChecked = new Map<string, number>();
  /** Checks and fires a tick started and did not wait for. */
  private background = new Set<Promise<unknown>>();

  /** Runs `work` without waiting for it; idle() does. */
  private detach(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Resolves once everything the ticks so far set off has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.deps.log.error({ err }, 'routine tick crashed'));
    }, TICK_MS);
    this.timer.unref?.();
    this.deps.log.info('routine scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduler pass: fire every due routine. Fires run concurrently —
   * overlap is prevented by the per-routine guard + manager's active-run gate. */
  async tick(now = Date.now()): Promise<void> {
    for (const routine of this.deps.store.listRoutines()) {
      if (!routine.enabled) continue;
      if (routine.schedule.kind === 'commit' || routine.schedule.kind === 'ci-failed') {
        this.detach(
          this.checkEvent(routine, now).catch((err) => this.deps.log.warn({ err, routine: routine.id }, 'routine event check failed')),
        );
        continue;
      }
      const due = nextRunAt(routine, now);
      if (due === null || due > now) continue;
      this.detach(this.fire(routine.id, 'schedule'));
    }
  }

  /**
   * Looks for the event a routine waits on. The first look only remembers what
   * is there — a routine does not fire for a commit or a failure that predates it.
   */
  private async checkEvent(routine: Routine, now: number): Promise<void> {
    const { store } = this.deps;
    const project = store.getProject(routine.projectId);
    if (!project || this.firing.has(routine.id)) return;
    let seen: string | undefined;
    let context: string | undefined;
    let trigger: RoutineTrigger;
    if (routine.schedule.kind === 'commit') {
      trigger = 'commit';
      const head = await (this.deps.headOf ?? gitHead)(project.path);
      if (!head) return;
      seen = head.hash;
      context = `New commit ${head.hash.slice(0, 8)}: ${head.subject}`;
    } else {
      trigger = 'ci-failed';
      if (now - (this.ciChecked.get(routine.id) ?? 0) < CI_POLL_MS) return;
      this.ciChecked.set(routine.id, now);
      const run = await (this.deps.latestCiRun ?? ghLatestRun)(project.path);
      if (!run) return;
      seen = run.id;
      if (run.failed) {
        context = [`CI run failed: ${run.name}`, run.branch ? `Branch: ${run.branch}` : '', run.url ? `Run: ${run.url}` : '']
          .filter(Boolean)
          .join('\n');
      }
    }
    const current = store.getRoutine(routine.id);
    if (!current || current.triggerState === seen) return;
    await store.saveRoutine({ ...current, triggerState: seen });
    if (current.triggerState === undefined || !context) return;
    this.detach(this.fire(routine.id, trigger, context));
  }

  /**
   * Fires a routine now (manual button, scheduler, event). `context` — what set
   * it off — is appended to the prompt. Never throws.
   */
  async fire(
    id: string,
    trigger: RoutineTrigger,
    context?: string,
  ): Promise<{ ok: boolean; status: string; sessionId?: string }> {
    const { store, manager, log } = this.deps;
    const routine = store.getRoutine(id);
    if (!routine) return { ok: false, status: 'missing' };
    if (this.firing.has(id)) return { ok: false, status: 'busy' };
    this.firing.add(id);
    try {
      const project = store.getProject(routine.projectId);
      if (!project) {
        await store.saveRoutine({ ...routine, enabled: false, lastStatus: 'error' });
        log.warn({ routine: id }, 'routine project vanished — disabled');
        return { ok: false, status: 'no-project' };
      }

      // One persistent session per routine, created on first fire.
      let session: Session | undefined = routine.sessionId ? store.getSession(routine.sessionId) : undefined;
      if (!session) {
        session = await store.newSession(
          {
            projectId: routine.projectId,
            agentId: routine.agentId,
            title: `[routine] ${routine.name}`,
            ...(routine.model !== undefined ? { model: routine.model } : {}),
            ...(routine.thinkingEffort !== undefined ? { thinkingEffort: routine.thinkingEffort } : {}),
            ...(routine.accountId ? { accountId: routine.accountId } : {}),
          },
          'routine',
        );
        await store.saveRoutine({ ...routine, sessionId: session.id });
      }

      if (manager.isActive(session.id)) {
        await store.saveRoutine({ ...routine, lastRunAt: Date.now(), lastStatus: 'skipped' });
        log.info({ routine: id }, 'routine skipped — previous run still active');
        return { ok: false, status: 'skipped', sessionId: session.id };
      }

      const message: ChatMessage = {
        id: newMessageId(),
        sessionId: session.id,
        role: 'user',
        agentId: routine.agentId,
        text: [
          routine.prompt,
          ...(context?.trim() ? [context.trim().slice(0, CONTEXT_MAX)] : []),
          ...(trigger === 'manual' ? [] : [`_(automated routine run — ${timestamp24h()})_`]),
        ].join('\n\n'),
        attachments: [],
        ts: Date.now(),
        source: 'routine',
      };
      await store.appendMessage(message);

      // A fresh context: the agent starts a new conversation, the chat keeps the old ones.
      if (routine.freshContext && session.externalSessionId) {
        session.externalSessionId = undefined;
        await store.saveSession(session);
      }

      const outcome = await manager.startTurn({
        session,
        project,
        text: message.text,
        attachments: [],
        ...(routine.model !== undefined ? { model: routine.model } : {}),
        ...(routine.thinkingEffort !== undefined ? { thinkingEffort: routine.thinkingEffort } : {}),
        source: 'routine',
        routineId: id,
      });

      const fresh = store.getRoutine(id) ?? routine;
      await store.saveRoutine({
        ...fresh,
        lastRunAt: Date.now(),
        lastStatus: outcome.ok ? 'ok' : 'error',
      });
      return { ok: outcome.ok, status: outcome.ok ? 'ok' : 'error', sessionId: session.id };
    } catch (err) {
      log.error({ err, routine: id }, 'routine fire crashed');
      const fresh = store.getRoutine(id);
      if (fresh) await store.saveRoutine({ ...fresh, lastStatus: 'error' });
      return { ok: false, status: 'error' };
    } finally {
      this.firing.delete(id);
    }
  }
}
