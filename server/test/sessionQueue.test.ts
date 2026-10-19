import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentEvent, ChatMessage, Project, Session } from '@agentdeck/shared';
import { AgentManager } from '../src/agents/manager.js';
import type { AgentAdapter, RunPlan } from '../src/agents/types.js';
import type { AgentService } from '../src/agents/registry.js';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/logging.js';
import type { AppDeps } from '../src/routes/deps.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { Store } from '../src/state/store.js';

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

/** "Agent" that holds every run until the gate file exists, then answers. */
function holdingAgents(gate: string): AgentService {
  const source = `
    const fs = require('node:fs');
    (async () => {
      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 10));
      process.stdout.write(JSON.stringify({ type: 'text-delta', text: 'done' }) + '\\n');
    })();`;
  const adapter = {
    id: 'claude',
    label: 'Fake',
    kind: 'cli',
    accentColor: '#fff',
    supportsResume: false,
    detect: async () => ({ available: true }),
    capabilities: () => ({ headless: true }),
    defaultModels: () => [],
    buildRun: (): RunPlan => ({
      command: 'node',
      args: ['-e', source],
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => emit(JSON.parse(line) as AgentEvent),
    }),
  } as unknown as AgentAdapter;
  return {
    get: () => adapter,
    infoOf: () => ({ id: 'claude', label: 'Fake', available: true, capabilities: { headless: true } }),
  } as unknown as AgentService;
}

/** "Agent" driven by a small step script; writes `start` markers so a test can count runs. */
function scriptedAgents(script: unknown[]): AgentService {
  const source = `
    const fs = require('node:fs');
    const steps = ${JSON.stringify(script)};
    (async () => {
      for (const step of steps) {
        if (step.start) {
          fs.appendFileSync(step.start, 'start\\n');
        } else if (step.hold) {
          while (!fs.existsSync(step.hold)) await new Promise((r) => setTimeout(r, 10));
        } else {
          process.stdout.write(JSON.stringify(step) + '\\n');
        }
      }
    })();`;
  const adapter = {
    id: 'claude',
    label: 'Fake',
    kind: 'cli',
    accentColor: '#fff',
    supportsResume: false,
    detect: async () => ({ available: true }),
    capabilities: () => ({ headless: true }),
    defaultModels: () => [],
    buildRun: (): RunPlan => ({
      command: 'node',
      args: ['-e', source],
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => emit(JSON.parse(line) as AgentEvent),
    }),
  } as unknown as AgentAdapter;
  return {
    get: () => adapter,
    infoOf: () => ({ id: 'claude', label: 'Fake', available: true, capabilities: { headless: true } }),
  } as unknown as AgentService;
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

interface QueueFixture {
  dir: string;
  gate: string;
  starts: string;
  store: Store;
  project: Project;
  config: ReturnType<typeof loadConfig>;
  session: Session;
  manager: AgentManager;
}

/** A private data dir per test — queue files must never be shared between tests. */
async function queueFixture(
  buildScript: (files: { gate: string; starts: string }) => unknown[],
): Promise<QueueFixture> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-queue-restart-'));
  restartDirs.push(dir);
  const gate = path.join(dir, 'gate');
  const starts = path.join(dir, 'starts.log');
  const store = new Store(dir);
  await store.init();
  const project = await store.saveProject({
    id: 'p_restart',
    name: 'restart',
    path: path.join(dir, 'project'),
    createdAt: 1,
    updatedAt: 1,
  });
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: dir }, configDir: path.join(dir, 'none') });
  const session = await store.newSession({ projectId: project.id, agentId: 'claude' });
  const manager = new AgentManager(
    config,
    store,
    scriptedAgents(buildScript({ gate, starts })),
    quietLogger,
    () => undefined,
  );
  return { dir, gate, starts, store, project, config, session, manager };
}

const restartDirs: string[] = [];

async function cleanupDirs(): Promise<void> {
  for (const dir of restartDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let tmp = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt = '';
let gate = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-queue-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  gate = path.join(tmp, 'gate');
  deps.manager = new AgentManager(config, deps.store, holdingAgents(gate), quietLogger, () => undefined);
  await deps.store.saveProject({
    id: 'p_queue',
    name: 'queue',
    path: path.join(tmp, 'project'),
    createdAt: 1,
    updatedAt: 1,
  });
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_queue', name: 'Queue Test' });
});

afterAll(async () => {
  await fsp.writeFile(gate, '').catch(() => undefined);
  await app.close().catch(() => undefined);
  await cleanupDirs();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('queued turns across a server restart', () => {
  /** Releases the gated run and waits until the manager let go of it. */
  async function release(manager: AgentManager, gate: string, sessionId: string): Promise<void> {
    await fsp.writeFile(gate, '').catch(() => undefined);
    for (let i = 0; i < 100 && manager.isActive(sessionId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('restores an accepted turn and runs it exactly once after a restart', async () => {
    const { dir, gate, starts, store, project, config, session, manager } = await queueFixture(
      ({ gate: runGate, starts: startLog }) => [
        { start: startLog },
        { hold: runGate },
        { type: 'text-delta', text: ' first answer' },
      ],
    );
    try {
      const userMessage = (text: string): ChatMessage => ({
        id: `m_${text}_${Date.now()}`,
        sessionId: session.id,
        role: 'user',
        text,
        attachments: [],
        ts: Date.now(),
      });
      expect(
        await manager.submitTurn(
          { session, project, text: 'one', attachments: [], source: 'app' },
          { userMessage: userMessage('one') },
        ),
      ).toEqual({ queued: false });
      await expect.poll(async () => (await readLines(starts)).length, { timeout: 5000 }).toBe(1);

      // The first run is active; this turn is parked behind it.
      expect(
        await manager.submitTurn(
          { session, project, text: 'two', attachments: [], source: 'app' },
          { userMessage: userMessage('two') },
        ),
      ).toEqual({ queued: true });

      const queueFile = path.join(dir, 'queued-turns.json');
      const persisted = JSON.parse(await fsp.readFile(queueFile, 'utf8')) as {
        version: number;
        turns: Record<string, unknown>[];
      };
      expect(persisted.version).toBe(1);
      expect(persisted.turns).toHaveLength(1);
      expect(persisted.turns[0]).toMatchObject({
        sessionId: session.id,
        projectId: project.id,
        text: 'two',
        attachments: [],
        source: 'app',
      });
      expect(typeof persisted.turns[0].queuedAt).toBe('number');
      expect((await fsp.stat(queueFile)).mode & 0o777).toBe(0o600);

      // A restart loses the old process' memory, not the file. Dropping the
      // old manager's queue simulates that; the persisted copy remains.
      (manager as unknown as { queues: Map<string, unknown[]> }).queues.delete(session.id);

      const restarted = new AgentManager(
        config,
        store,
        scriptedAgents([{ start: starts }, { type: 'text-delta', text: ' second answer' }]),
        quietLogger,
        () => undefined,
      );
      expect(restarted.queuedCount(session.id)).toBe(1);
      restarted.resumeQueuedTurns();

      // The restored turn's process ran once, the first run is still held.
      await expect.poll(async () => (await readLines(starts)).length, { timeout: 5000 }).toBe(2);
      await expect
        .poll(() => restarted.queuedCount(session.id) === 0 && !restarted.isActive(session.id), { timeout: 5000 })
        .toBe(true);

      const messages = await store.getMessages(session.id);
      // The user messages were written before the restart and are not repeated.
      expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['one', 'two']);
      expect(messages.filter((m) => m.role === 'assistant' && m.text === ' second answer')).toHaveLength(1);

      const afterResume = JSON.parse(await fsp.readFile(queueFile, 'utf8')) as { turns: unknown[] };
      expect(afterResume.turns).toEqual([]);
    } finally {
      await release(manager, gate, session.id);
    }
  });

  it('clearQueue also removes the persisted entries', async () => {
    const { dir, gate, starts, store, project, config, session, manager } = await queueFixture(
      ({ gate: runGate, starts: startLog }) => [
        { start: startLog },
        { hold: runGate },
        { type: 'text-delta', text: ' done' },
      ],
    );
    try {
      await manager.submitTurn({ session, project, text: 'one', attachments: [], source: 'app' });
      await expect.poll(async () => (await readLines(starts)).length, { timeout: 5000 }).toBe(1);
      await manager.submitTurn({ session, project, text: 'two', attachments: [], source: 'app' });

      const queueFile = path.join(dir, 'queued-turns.json');
      const before = JSON.parse(await fsp.readFile(queueFile, 'utf8')) as { turns: unknown[] };
      expect(before.turns).toHaveLength(1);

      manager.clearQueue(session.id);
      await expect
        .poll(async () => {
          const file = JSON.parse(await fsp.readFile(queueFile, 'utf8')) as { turns: unknown[] };
          return file.turns.length;
        })
        .toBe(0);

      // A fresh manager finds nothing to resume.
      const restarted = new AgentManager(
        config,
        store,
        scriptedAgents([{ start: starts }, { type: 'text-delta', text: ' must not run' }]),
        quietLogger,
        () => undefined,
      );
      expect(restarted.queuedCount(session.id)).toBe(0);
      restarted.resumeQueuedTurns();
    } finally {
      await release(manager, gate, session.id);
    }

    expect((await readLines(starts)).filter((line) => line === 'start')).toHaveLength(1);
    const messages = await store.getMessages(session.id);
    expect(messages.some((m) => m.text === ' must not run')).toBe(false);
  });
});

describe('POST /api/sessions/:id/messages queue cap', () => {
  it('rejects the 11th queued turn without writing the message or session changes', async () => {
    const session = await deps.store.newSession({ projectId: 'p_queue', agentId: 'claude' });
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: { authorization: `Bearer ${jwt}` },
        payload,
      });

    // The spaces keep the title at "New session", so the rejected turn would
    // visibly change it if it were persisted before the capacity check.
    const first = await post({ text: ' ' });
    expect(first.statusCode).toBe(200);
    for (let i = 0; i < 10; i++) {
      const queued = await post({ text: ' ' });
      expect(queued.statusCode).toBe(200);
      expect(queued.json()).toMatchObject({ queued: true });
    }
    expect(deps.manager.queuedCount(session.id)).toBe(10);

    const beforeMessages = await deps.store.getMessages(session.id);
    const before = deps.store.getSession(session.id)!;
    expect(beforeMessages).toHaveLength(11);
    expect(before.title).toBe('New session');
    expect(before.model).toBeUndefined();
    expect(before.thinkingEffort).toBeUndefined();

    const rejected = await post({ text: 'rejected title', model: 'evil/model', thinkingEffort: 'high' });
    expect(rejected.statusCode).toBe(409);
    expect((rejected.json() as { error: { code: string } }).error.code).toBe('QUEUE_FULL');

    // Nothing of the rejected turn reached the store.
    const afterMessages = await deps.store.getMessages(session.id);
    expect(afterMessages.map((m) => m.id)).toEqual(beforeMessages.map((m) => m.id));
    const after = deps.store.getSession(session.id)!;
    expect(after.title).toBe('New session');
    expect(after.model).toBeUndefined();
    expect(after.thinkingEffort).toBeUndefined();

    // Release the held run; the ten queued turns finish in order.
    await fsp.writeFile(gate, '');
    await expect
      .poll(() => deps.manager.queuedCount(session.id) === 0 && !deps.manager.isActive(session.id), { timeout: 10_000 })
      .toBe(true);
  });
});
