import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Routine } from '@agentdeck/shared';
import { Store } from '../src/state/store.js';
import { RoutineScheduler, nextRunAt, validateSchedule } from '../src/routines/scheduler.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { Logger } from '../src/logging.js';

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Nightly lint',
    projectId: 'p1',
    agentId: 'claude',
    prompt: 'run lint',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...over,
  };
}

describe('routine schedule math', () => {
  it('interval: fires minutes after the last run', () => {
    const r = routine({ lastRunAt: 1_000_000, schedule: { kind: 'interval', minutes: 15 } });
    expect(nextRunAt(r)).toBe(1_000_000 + 15 * 60_000);
  });

  it('interval without a last run anchors at creation', () => {
    const r = routine({ schedule: { kind: 'interval', minutes: 5 } });
    expect(nextRunAt(r)).toBe(1_000_000 + 5 * 60_000);
  });

  it('daily: same time tomorrow when today already fired', () => {
    const last = new Date('2026-09-30T12:00:00').getTime();
    const r = routine({ lastRunAt: last, schedule: { kind: 'daily', time: '09:00' } });
    const due = nextRunAt(r, new Date('2026-09-30T15:00:00').getTime());
    const dueDate = new Date(due);
    expect(dueDate.getMonth()).toBe(9); // October (0-based)
    expect(dueDate.getDate()).toBe(1);
    expect(dueDate.getHours()).toBe(9);
  });

  it('daily: fires today when the time is still ahead', () => {
    const created = new Date('2026-09-30T07:00:00').getTime();
    const r = routine({ createdAt: created, schedule: { kind: 'daily', time: '09:00' } });
    const due = nextRunAt(r, new Date('2026-09-30T08:00:00').getTime());
    expect(new Date(due).getDate()).toBe(new Date(created).getDate());
    expect(new Date(due).getHours()).toBe(9);
  });

  it('weekly: lands on the requested weekday', () => {
    const created = new Date('2026-09-28T08:00:00').getTime(); // Monday
    const r = routine({
      createdAt: created,
      schedule: { kind: 'weekly', weekday: 5, time: '17:30' }, // Friday
    });
    const due = nextRunAt(r, new Date('2026-09-28T09:00:00').getTime());
    expect(new Date(due).getDay()).toBe(5);
    expect(new Date(due).getHours()).toBe(17);
    expect(due).toBeGreaterThan(created);
  });

  it('validates schedules', () => {
    expect(validateSchedule({ kind: 'interval', minutes: 0 })).toMatch(/1\.\.20160/);
    expect(validateSchedule({ kind: 'interval', minutes: 10 })).toBeNull();
    expect(validateSchedule({ kind: 'daily', time: '25:00' })).toMatch(/HH:MM/);
    expect(validateSchedule({ kind: 'daily', time: '23:59' })).toBeNull();
    expect(validateSchedule({ kind: 'weekly', weekday: 9, time: '08:00' })).toMatch(/0 \(Sunday\)/);
  });
});

describe('RoutineScheduler.fire', () => {
  async function harness(opts: { activeSessionIds?: string[]; store?: Store } = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-routines-'));
    const store = opts.store ?? new Store(dir);
    await store.init();
    await store.saveProject({
      id: 'p1', name: 'demo', path: path.join(dir, 'demo'), createdAt: Date.now(), updatedAt: Date.now(),
    });
    const calls: { sessionId: string; text: string }[] = [];
    const active = new Set(opts.activeSessionIds ?? []);
    const manager = {
      isActive: (id: string) => active.has(id),
      startTurn: async (opts2: { session: { id: string }; text: string }) => {
        calls.push({ sessionId: opts2.session.id, text: opts2.text });
        return { ok: true, text: 'done' };
      },
    } as unknown as AgentManager;
    const scheduler = new RoutineScheduler({ store, manager, log: quietLogger });
    return { dir, store, scheduler, calls, active };
  }

  it('creates one persistent session, appends a routine message and starts a turn', async () => {
    const { store, scheduler, calls } = await harness();
    await store.saveRoutine(routine());
    const result = await scheduler.fire('r1', 'manual');
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(calls).toHaveLength(1);

    const saved = store.getRoutine('r1');
    expect(saved?.sessionId).toBe(result.sessionId);
    expect(saved?.lastStatus).toBe('ok');

    const messages = await store.getMessages(result.sessionId!);
    expect(messages).toHaveLength(1);
    expect(messages[0].source).toBe('routine');
    expect(messages[0].role).toBe('user');
    // fire again → SAME session reused
    await scheduler.fire('r1', 'manual');
    expect(store.getRoutine('r1')?.sessionId).toBe(result.sessionId);
    expect(calls).toHaveLength(2);
  });

  it('skips the fire while the routine session has an active run', async () => {
    const { store, scheduler, calls } = await harness();
    await store.saveRoutine(routine());
    const first = await scheduler.fire('r1', 'manual');
    expect(first.ok).toBe(true);
    // Second scheduler whose manager reports the routine's session as active.
    const sessionId = store.getRoutine('r1')?.sessionId ?? '';
    const { scheduler: scheduler2 } = await harness({ store, activeSessionIds: [sessionId] });
    const second = await scheduler2.fire('r1', 'manual');
    expect(second.status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('disables a routine whose project vanished', async () => {
    const { store, scheduler } = await harness();
    await store.saveRoutine(routine({ projectId: 'gone' }));
    const result = await scheduler.fire('r1', 'manual');
    expect(result.status).toBe('no-project');
    expect(store.getRoutine('r1')?.enabled).toBe(false);
  });

  it('tick fires only due, enabled routines', async () => {
    const { store, scheduler, calls } = await harness();
    await store.saveRoutine(routine({ id: 'due', lastRunAt: Date.now() - 60 * 60_000 }));
    await store.saveRoutine(routine({ id: 'fresh', lastRunAt: Date.now() }));
    await store.saveRoutine(routine({ id: 'off', enabled: false, lastRunAt: Date.now() - 60 * 60_000 }));
    await scheduler.tick();
    // tick fires concurrently — poll briefly until the due routine reported.
    for (let i = 0; i < 20 && calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(calls).toHaveLength(1);
    expect(store.getRoutine('fresh')?.lastStatus).toBeUndefined();
    expect(store.getRoutine('off')?.lastStatus).toBeUndefined();
  });
});
