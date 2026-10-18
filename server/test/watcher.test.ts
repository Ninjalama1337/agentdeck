/**
 * Live watcher tests: real fs.watch on a temp project dir + the real HTTP
 * routes. Broadcasts are captured by patching io.emit (makeBroadcaster reads
 * it at call time). Events are debounced 400 ms — assertions poll well past
 * that window.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeckIo } from '../src/ws/gateway.js';
import type { FileChangeEvent } from '@agentdeck/shared';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { FileWatchers } from '../src/files/watcher.js';

const DEBOUNCE_MS = 400;
const WAIT = { timeout: 4000, interval: 25 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tmp = '';
let projectDir = '';
let projectId = '';
let app: FastifyInstance;
let io: DeckIo;
let deps: AppDeps;
let jwt: string;

/** Every broadcast payload since boot (io.emit patch). */
let broadcasts: { event: string; payload: unknown }[] = [];

function filesEvents(): FileChangeEvent[] {
  return broadcasts
    .filter(
      (b) =>
        b.event === 'files:changed' &&
        (b.payload as { projectId?: string }).projectId === projectId,
    )
    .flatMap((b) => (b.payload as { events: FileChangeEvent[] }).events);
}

function eventsFor(rel: string): FileChangeEvent[] {
  return filesEvents().filter((e) => e.path === rel);
}

async function listFiles(): Promise<void> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/files`,
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.statusCode).toBe(200);
}

function putContent(rel: string, content: string) {
  return app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/files/content`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { path: rel, content },
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-watcher-'));
  const config = loadConfig(
    {
      env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' },
      configDir: path.join(tmp, 'none'),
    },
  );
  const built = await buildApp(config);
  app = built.app;
  io = built.io;
  deps = built.deps;
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_watch_1', name: 'Watcher Test' });

  (io as unknown as { emit: unknown }).emit = (event: string, payload: unknown) => {
    broadcasts.push({ event, payload });
    return true;
  };

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: 'Watcher Project', initGit: true },
  });
  expect(created.statusCode).toBe(201);
  const project = created.json() as { id: string; path: string };
  projectId = project.id;
  projectDir = project.path;

  // Arm the watcher through the API (lazy start on first file access).
  await listFiles();
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('FileWatchers', () => {
  it('reports a new file as create even when its change event overtakes the existence check', async () => {
    // fs.watch reports rename + change for a new file; the rename is classified
    // asynchronously, so on a slow machine the change used to win the batch.
    const dir = await fsp.mkdtemp(path.join(tmp, 'race-'));
    await fsp.writeFile(path.join(dir, 'new.txt'), 'x', 'utf8');
    const batches: { type: string; path: string }[][] = [];
    const watchers = new FileWatchers({
      broadcast: ((event: string, payload: { events: { type: string; path: string }[] }) => {
        if (event === 'files:changed') batches.push(payload.events);
      }) as never,
      log: { warn: () => undefined, info: () => undefined } as never,
      debounceMs: 20,
    });
    try {
      watchers.ensureStarted('race', dir);
      const internals = watchers as unknown as {
        states: Map<string, unknown>;
        onFsEvent(state: unknown, type: 'rename' | 'change', filename: string): void;
      };
      const state = internals.states.get('race');
      internals.onFsEvent(state, 'rename', 'new.txt');
      internals.onFsEvent(state, 'change', 'new.txt');
      await vi.waitFor(() => expect(batches.flat()).toEqual([{ type: 'create', path: 'new.txt' }]), WAIT);

      // A later edit of the now-known file is a change.
      batches.length = 0;
      internals.onFsEvent(state, 'change', 'new.txt');
      await vi.waitFor(() => expect(batches.flat()).toEqual([{ type: 'change', path: 'new.txt' }]), WAIT);
    } finally {
      watchers.stopAll();
    }
  });

  it('keeps a brand-new file a create when its change event arrives first', async () => {
    // Reproduces the slow-machine order: the `change` for a new file is queued
    // before the `rename` that would classify it as a create.
    const dir = await fsp.mkdtemp(path.join(tmp, 'race-'));
    const batches: { type: string; path: string }[][] = [];
    const watchers = new FileWatchers({
      broadcast: ((event: string, payload: { events: { type: string; path: string }[] }) => {
        if (event === 'files:changed') batches.push(payload.events);
      }) as never,
      log: { warn: () => undefined, info: () => undefined } as never,
      debounceMs: 20,
    });
    try {
      watchers.ensureStarted('race-order', dir);
      const internals = watchers as unknown as {
        states: Map<string, unknown>;
        onFsEvent(state: unknown, type: 'rename' | 'change', filename: string): void;
      };
      const state = internals.states.get('race-order');
      await fsp.writeFile(path.join(dir, 'order.txt'), 'x', 'utf8');
      batches.length = 0;
      internals.onFsEvent(state, 'change', 'order.txt');
      internals.onFsEvent(state, 'rename', 'order.txt');
      await vi.waitFor(() => expect(batches.flat()).toEqual([{ type: 'create', path: 'order.txt' }]), WAIT);
    } finally {
      watchers.stopAll();
    }
  });

  it('emits create for a file written directly on disk', async () => {
    await fsp.writeFile(path.join(projectDir, 'direct.txt'), 'from disk', 'utf8');
    await vi.waitFor(
      () => expect(eventsFor('direct.txt')).toEqual([{ type: 'create', path: 'direct.txt' }]),
      WAIT,
    );
  });

  it('reports nested paths with forward slashes', async () => {
    await fsp.mkdir(path.join(projectDir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'sub', 'nested.txt'), 'deep', 'utf8');
    await vi.waitFor(
      () => expect(eventsFor('sub/nested.txt')).toContainEqual({ type: 'create', path: 'sub/nested.txt' }),
      WAIT,
    );
  });

  it('coalesces an API PUT + its own fs events into a single event', async () => {
    // Seed a file on disk first and let its create event flush.
    await fsp.writeFile(path.join(projectDir, 'coalesce.txt'), 'seed', 'utf8');
    await vi.waitFor(() => expect(eventsFor('coalesce.txt').length).toBe(1), WAIT);

    const before = broadcasts.length;
    const res = await putContent('coalesce.txt', 'written via API');
    expect(res.statusCode).toBe(200);
    // Wait well past the debounce window: watcher + synthetic event must
    // collapse into exactly ONE event for this path.
    await sleep(DEBOUNCE_MS * 2 + 300);
    const during = broadcasts
      .slice(before)
      .filter((b) => b.event === 'files:changed')
      .flatMap((b) => (b.payload as { events: FileChangeEvent[] }).events)
      .filter((e) => e.path === 'coalesce.txt');
    expect(during).toEqual([{ type: 'change', path: 'coalesce.txt' }]);
  });

  it('emits create (not change) once for a file created via the API', async () => {
    const before = broadcasts.length;
    const res = await putContent('api-new.txt', 'fresh');
    expect(res.statusCode).toBe(200);
    await sleep(DEBOUNCE_MS * 2 + 300);
    const during = broadcasts
      .slice(before)
      .filter((b) => b.event === 'files:changed')
      .flatMap((b) => (b.payload as { events: FileChangeEvent[] }).events)
      .filter((e) => e.path === 'api-new.txt');
    expect(during).toEqual([{ type: 'create', path: 'api-new.txt' }]);
  });

  it('emits delete when a file is removed on disk', async () => {
    await fsp.rm(path.join(projectDir, 'direct.txt'));
    await vi.waitFor(
      () => expect(eventsFor('direct.txt')).toContainEqual({ type: 'delete', path: 'direct.txt' }),
      WAIT,
    );
  });

  it('never emits for .git internals', async () => {
    const before = filesEvents().length;
    await fsp.writeFile(path.join(projectDir, '.git', 'config'), 'tampered', 'utf8');
    await fsp.rm(path.join(projectDir, '.git', 'HEAD'));
    await sleep(DEBOUNCE_MS * 2 + 300);
    const gitEvents = filesEvents()
      .slice(before)
      .filter((e) => e.path === '.git' || e.path.startsWith('.git/'));
    expect(gitEvents).toEqual([]);
  });

  it('degrades without crashing when the watched root is missing', () => {
    const missingRoot = path.join(tmp, 'does-not-exist');
    expect(() => deps.fileWatchers.ensureStarted('ghost-project', missingRoot)).not.toThrow();
    // Second call hits the degraded-restart path — still no throw.
    expect(() => deps.fileWatchers.ensureStarted('ghost-project', missingRoot)).not.toThrow();
  });
});
