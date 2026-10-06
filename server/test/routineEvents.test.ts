import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Routine } from '@agentdeck/shared';
import type { FastifyInstance } from 'fastify';
import { Store } from '../src/state/store.js';
import { RoutineScheduler, nextRunAt, validateSchedule, type CiRun, type HeadInfo } from '../src/routines/scheduler.js';
import type { AgentManager } from '../src/agents/manager.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import type { AppDeps } from '../src/routes/deps.js';
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
    name: 'On commit',
    projectId: 'p1',
    agentId: 'claude',
    prompt: 'review it',
    schedule: { kind: 'commit' },
    enabled: true,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...over,
  };
}

interface Call {
  text: string;
  routineId?: string;
  resumeId?: string;
}

async function harness() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-routine-events-'));
  const store = new Store(dir);
  await store.init();
  await store.saveProject({ id: 'p1', name: 'demo', path: path.join(dir, 'demo'), createdAt: 1, updatedAt: 1 });
  const calls: Call[] = [];
  const manager = {
    isActive: () => false,
    startTurn: async (o: { session: { id: string; externalSessionId?: string }; text: string; routineId?: string }) => {
      calls.push({ text: o.text, routineId: o.routineId, resumeId: o.session.externalSessionId });
      // The agent hands back a conversation id, as a real run does.
      const session = store.getSession(o.session.id);
      if (session) await store.saveSession({ ...session, externalSessionId: `conv-${calls.length}` });
      return { ok: true, text: 'done' };
    },
  } as unknown as AgentManager;
  const world: { head?: HeadInfo; ci?: CiRun; ciAsked: number } = { ciAsked: 0 };
  const scheduler = new RoutineScheduler({
    store,
    manager,
    log: quietLogger,
    headOf: async () => world.head,
    latestCiRun: async () => {
      world.ciAsked += 1;
      return world.ci;
    },
  });
  /** One tick, and time for the fires it started. */
  const tick = async (now: number) => {
    await scheduler.tick(now);
    await new Promise((r) => setTimeout(r, 60));
  };
  return { store, scheduler, calls, world, tick };
}

describe('event routines', () => {
  it('have no clock and need no schedule fields', () => {
    for (const kind of ['commit', 'ci-failed', 'webhook'] as const) {
      expect(nextRunAt(routine({ schedule: { kind } }))).toBeNull();
      expect(validateSchedule({ kind })).toBeNull();
    }
  });

  it('commit: remembers the commit it starts with and fires for the next one', async () => {
    const { store, calls, world, tick } = await harness();
    await store.saveRoutine(routine());
    world.head = { hash: 'aaaaaaaa1111', subject: 'first' };
    await tick(1);
    expect(calls).toHaveLength(0);
    expect(store.getRoutine('r1')?.triggerState).toBe('aaaaaaaa1111');

    await tick(2); // nothing new
    expect(calls).toHaveLength(0);

    world.head = { hash: 'bbbbbbbb2222', subject: 'Fix the parser' };
    await tick(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('review it');
    expect(calls[0]?.text).toContain('New commit bbbbbbbb: Fix the parser');
    expect(calls[0]?.routineId).toBe('r1');

    await tick(4); // the same commit does not fire twice
    expect(calls).toHaveLength(1);
  });

  it('ci-failed: fires once per failed run, not for green ones, and asks GitHub sparingly', async () => {
    const { store, calls, world, tick } = await harness();
    await store.saveRoutine(routine({ schedule: { kind: 'ci-failed' } }));
    const MIN = 60_000;
    world.ci = { id: '10', failed: true, name: 'CI — old failure' };
    await tick(10 * MIN);
    expect(calls).toHaveLength(0); // a failure from before the routine existed

    world.ci = { id: '11', failed: false, name: 'CI — green' };
    await tick(10 * MIN + 30_000); // too soon: not asked again
    expect(world.ciAsked).toBe(1);
    await tick(13 * MIN);
    expect(calls).toHaveLength(0);

    world.ci = { id: '12', failed: true, name: 'CI — tests', branch: 'main', url: 'https://github.com/x/y/actions/runs/12' };
    await tick(16 * MIN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('CI run failed: CI — tests');
    expect(calls[0]?.text).toContain('https://github.com/x/y/actions/runs/12');
    await tick(19 * MIN);
    expect(calls).toHaveLength(1);
  });

  it('a paused event routine does not look or fire', async () => {
    const { store, calls, world, tick } = await harness();
    await store.saveRoutine(routine({ enabled: false }));
    world.head = { hash: 'a', subject: 'x' };
    await tick(1);
    expect(store.getRoutine('r1')?.triggerState).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('fresh context: every run starts a new conversation; without it the last one is resumed', async () => {
    const fresh = await harness();
    await fresh.store.saveRoutine(routine({ freshContext: true }));
    await fresh.scheduler.fire('r1', 'manual');
    await fresh.scheduler.fire('r1', 'manual');
    expect(fresh.calls.map((c) => c.resumeId)).toEqual([undefined, undefined]);

    const kept = await harness();
    await kept.store.saveRoutine(routine());
    await kept.scheduler.fire('r1', 'manual');
    await kept.scheduler.fire('r1', 'webhook', 'Webhook payload:\n{"ref":"main"}');
    expect(kept.calls.map((c) => c.resumeId)).toEqual([undefined, 'conv-1']);
    expect(kept.calls[1]?.text).toContain('{"ref":"main"}');
  });
});

describe('routine webhook + history routes', () => {
  let tmp = '';
  let app: FastifyInstance;
  let deps: AppDeps;
  let auth = '';
  const fired: { id: string; trigger: string; context?: string }[] = [];

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-routine-hook-'));
    const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
    const built = await buildApp(config);
    app = built.app;
    deps = built.deps;
    await app.ready();
    const device = await deps.store.registerDevice('test');
    auth = `Bearer ${await signDeviceToken(deps.jwtSecret, { deviceId: device.id, name: device.name })}`;
    await deps.store.saveProject({ id: 'p1', name: 'demo', path: path.join(tmp, 'demo'), createdAt: 1, updatedAt: 1 });
    deps.routines.fire = async (id, trigger, context) => {
      fired.push({ id, trigger, ...(context ? { context } : {}) });
      return { ok: true, status: 'ok' };
    };
  });

  afterAll(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const create = async (schedule: Routine['schedule']) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/routines',
        headers: { authorization: auth },
        payload: { name: 'Hooked', projectId: 'p1', agentId: 'claude', prompt: 'go', schedule, freshContext: true },
      })
    ).json() as Routine;

  it('gives a webhook routine a secret address that fires it without a device login', async () => {
    const made = await create({ kind: 'webhook' });
    expect(made.hookToken).toMatch(/^[\w-]{20,}$/);
    expect(made.freshContext).toBe(true);
    expect((await create({ kind: 'commit' })).hookToken).toBeUndefined();

    const hook = `/api/hooks/routine/${made.id}/${made.hookToken}`;
    const ok = await app.inject({ method: 'POST', url: hook, payload: { ref: 'main' } });
    expect(ok.statusCode).toBe(202);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ id: made.id, trigger: 'webhook' });
    expect(fired[0]?.context).toContain('"ref": "main"');

    const text = await app.inject({ method: 'POST', url: hook, headers: { 'content-type': 'text/plain' }, payload: 'deploy failed' });
    expect(text.statusCode).toBe(202);
    expect(fired[1]?.context).toBe('Webhook payload:\ndeploy failed');
    expect((await app.inject({ method: 'POST', url: hook })).statusCode).toBe(202);
    expect(fired[2]?.context).toBeUndefined();

    // Wrong secret, unknown routine: the same 404, and nothing fires.
    expect((await app.inject({ method: 'POST', url: `/api/hooks/routine/${made.id}/nope` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/hooks/routine/r_missing/${made.hookToken}` })).statusCode).toBe(404);
    expect(fired).toHaveLength(3);

    // A new address replaces the old one.
    const renewed = (
      await app.inject({ method: 'POST', url: `/api/routines/${made.id}/hook-token`, headers: { authorization: auth } })
    ).json() as Routine;
    expect(renewed.hookToken).not.toBe(made.hookToken);
    expect((await app.inject({ method: 'POST', url: hook })).statusCode).toBe(404);

    // Paused: the address answers, the routine stays quiet.
    await app.inject({ method: 'PATCH', url: `/api/routines/${made.id}`, headers: { authorization: auth }, payload: { enabled: false } });
    const paused = await app.inject({ method: 'POST', url: `/api/hooks/routine/${made.id}/${renewed.hookToken}` });
    expect(paused.statusCode).toBe(409);
    expect(fired).toHaveLength(3);
  });

  it('lists a routine\'s runs from the activity record, behind the device login', async () => {
    const made = await create({ kind: 'interval', minutes: 30 });
    deps.stats.recordRun({ id: 'run_a', startedAt: 1000, endedAt: 2000, agentId: 'claude', source: 'routine', routineId: made.id, status: 'ok', summary: 'All green.' });
    deps.stats.recordRun({ id: 'run_b', startedAt: 3000, endedAt: 9000, agentId: 'claude', source: 'routine', routineId: 'other', status: 'ok' });
    const res = await app.inject({ method: 'GET', url: `/api/routines/${made.id}/runs`, headers: { authorization: auth } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual(['run_a']);
    expect((await app.inject({ method: 'GET', url: `/api/routines/${made.id}/runs` })).statusCode).toBe(401);
  });
});
