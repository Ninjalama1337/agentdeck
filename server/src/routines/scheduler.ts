/**
 * RoutineScheduler: agents on recurring jobs (BridgeMind routines).
 *
 * Ticks every 30 s, computes the next fire time per routine (pure function,
 * unit-tested) and starts a normal agent turn in the routine's persistent
 * session. A fire is skipped while that session still has an active run.
 */
import type { Routine, RoutineSchedule } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentManager } from '../agents/manager.js';
import type { ChatMessage, Session } from '@agentdeck/shared';
import { newMessageId } from '../util/ids.js';

const TICK_MS = 30_000;

export interface SchedulerDeps {
  store: Store;
  manager: AgentManager;
  log: Logger;
}

/** Pure: when this routine fires next (ms epoch), or null when unknown. */
export function nextRunAt(routine: Routine, now = Date.now()): number | null {
  const anchor = routine.lastRunAt ?? routine.createdAt;
  const schedule = routine.schedule;
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
      const due = nextRunAt(routine, now);
      if (due === null || due > now) continue;
      void this.fire(routine.id, 'schedule');
    }
  }

  /** Fires a routine now (manual button or scheduler). Never throws. */
  async fire(id: string, trigger: 'schedule' | 'manual'): Promise<{ ok: boolean; status: string; sessionId?: string }> {
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
        text:
          trigger === 'manual'
            ? routine.prompt
            : `${routine.prompt}\n\n_(automated routine run — ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' })})_`,
        attachments: [],
        ts: Date.now(),
        source: 'routine',
      };
      await store.appendMessage(message);

      const outcome = await manager.startTurn({
        session,
        project,
        text: message.text,
        attachments: [],
        ...(routine.model !== undefined ? { model: routine.model } : {}),
        ...(routine.thinkingEffort !== undefined ? { thinkingEffort: routine.thinkingEffort } : {}),
        source: 'routine',
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
