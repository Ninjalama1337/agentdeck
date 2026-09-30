import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeckIo } from '../src/ws/gateway.js';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import type { FileContentResponse, SaveFileResponse } from '@agentdeck/shared';

const CAP = 1_048_576;

let tmp = '';
let projectDir = '';
let projectId = '';
let app: FastifyInstance;
let io: DeckIo;
let deps: AppDeps;
let jwt: string;

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });
}
function put(url: string, body: unknown) {
  return app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${jwt}` }, payload: body });
}
function post(url: string, body: unknown) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${jwt}` }, payload: body });
}
function del(url: string) {
  return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${jwt}` } });
}
const contentUrl = () => `/api/projects/${projectId}/files/content`;
const createUrl = () => `/api/projects/${projectId}/files/create`;
const entryUrl = () => `/api/projects/${projectId}/files/entry`;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-filesedit-'));
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
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_edit_1', name: 'Edit Test' });

  const created = await post('/api/projects', { name: 'Edit Project', initGit: true });
  expect(created.statusCode).toBe(201);
  const project = created.json() as { id: string; path: string };
  projectId = project.id;
  projectDir = project.path;
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('PUT/GET /files/content', () => {
  it('round-trips UTF-8 content with umlauts and emoji', async () => {
    const content = '# Hällo Wörld 🎉\nZweite Zeile — mit Emoji 🚀✅\n';
    const putRes = await put(contentUrl(), { path: 'notes.md', content });
    expect(putRes.statusCode).toBe(200);
    const saved = putRes.json() as SaveFileResponse;
    expect(saved.path).toBe('notes.md');
    expect(saved.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(saved.savedAt).toBeGreaterThan(0);
    // Written atomically: no leftover temp artifacts next to the file.
    const dirEntries = await fsp.readdir(projectDir);
    expect(dirEntries.some((e) => e.startsWith('.agentdeck-edit-'))).toBe(false);

    const getRes = await get(`${contentUrl()}?path=${encodeURIComponent('notes.md')}`);
    expect(getRes.statusCode).toBe(200);
    const file = getRes.json() as FileContentResponse;
    expect(file.path).toBe('notes.md');
    expect(file.content).toBe(content);
    expect(file.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(file.mime).toBe('text/markdown; charset=utf-8');
    expect(file.truncated).toBe(false);
  });

  it('auto-creates missing parent directories via PUT', async () => {
    const res = await put(contentUrl(), { path: 'a/b/c.txt', content: 'deep' });
    expect(res.statusCode).toBe(200);
    await expect(fsp.readFile(path.join(projectDir, 'a', 'b', 'c.txt'), 'utf8')).resolves.toBe('deep');
  });

  it('marks large files truncated and caps content at 1 MB on read', async () => {
    const big = `${'x'.repeat(CAP)}TAIL`;
    await fsp.writeFile(path.join(projectDir, 'big.txt'), big, 'utf8');
    const res = await get(`${contentUrl()}?path=big.txt`);
    expect(res.statusCode).toBe(200);
    const file = res.json() as FileContentResponse;
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(CAP);
    expect(file.size).toBe(big.length);
    expect(file.content.endsWith('TAIL')).toBe(false);
  });

  it('rejects oversized PUT bodies with 400', async () => {
    const res = await put(contentUrl(), { path: 'too-big.txt', content: 'a'.repeat(CAP + 1) });
    expect(res.statusCode).toBe(400);
  });

  it('rejects binary files on read and NUL content on write with 415 NON_TEXT', async () => {
    await fsp.writeFile(path.join(projectDir, 'blob.bin'), Buffer.from([0x70, 0x00, 0x6f, 0x73]));
    const getRes = await get(`${contentUrl()}?path=blob.bin`);
    expect(getRes.statusCode).toBe(415);
    expect(getRes.json().error.code).toBe('NON_TEXT');

    const putRes = await put(contentUrl(), { path: 'nul.txt', content: 'before\0after' });
    expect(putRes.statusCode).toBe(415);
    expect(putRes.json().error.code).toBe('NON_TEXT');
  });

  it('404s for missing files and 400s for directories', async () => {
    const missing = await get(`${contentUrl()}?path=nope.txt`);
    expect(missing.statusCode).toBe(404);
    const dir = await get(`${contentUrl()}?path=a`);
    expect(dir.statusCode).toBe(400);
  });

  it('validates the query/body shape', async () => {
    expect((await get(contentUrl())).statusCode).toBe(400);
    expect((await put(contentUrl(), { path: '', content: 'x' })).statusCode).toBe(400);
    expect((await put(contentUrl(), { content: 'x' })).statusCode).toBe(400);
  });
});

describe('.git protection', () => {
  it('blocks write, delete and nested .git paths (case-insensitive)', async () => {
    for (const p of ['.git/config', '.git/HEAD', '.GIT/description', 'sub/.git/objects/x']) {
      const putRes = await put(contentUrl(), { path: p, content: 'tamper' });
      expect(putRes.statusCode).toBe(403);
      expect(putRes.json().error.code).toBe('FORBIDDEN_PATH');
      const delRes = await del(`${entryUrl()}?path=${encodeURIComponent(p)}`);
      expect(delRes.statusCode).toBe(403);
      expect(delRes.json().error.code).toBe('FORBIDDEN_PATH');
      const createRes = await post(createUrl(), { path: p, kind: 'file' });
      expect(createRes.statusCode).toBe(403);
    }
    // .gitignore-style names are fine — only exact .git segments are blocked.
    expect((await put(contentUrl(), { path: '.gitignore', content: 'dist/\n' })).statusCode).toBe(200);
  });

  it('blocks paths whose symlink target resolves inside .git', async () => {
    await fsp.symlink(path.join(projectDir, '.git', 'config'), path.join(projectDir, 'gitlink'));
    const res = await put(contentUrl(), { path: 'gitlink', content: 'via symlink' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_PATH');
  });
});

describe('POST /files/create', () => {
  it('creates an empty file and a directory, 409 on EXISTS', async () => {
    expect((await post(createUrl(), { path: 'new.txt', kind: 'file' })).statusCode).toBe(204);
    await expect(fsp.readFile(path.join(projectDir, 'new.txt'), 'utf8')).resolves.toBe('');
    const again = await post(createUrl(), { path: 'new.txt', kind: 'file' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('EXISTS');

    expect((await post(createUrl(), { path: 'newdir/nested', kind: 'dir' })).statusCode).toBe(204);
    expect((await fsp.stat(path.join(projectDir, 'newdir', 'nested'))).isDirectory()).toBe(true);
    const dirAgain = await post(createUrl(), { path: 'newdir/nested', kind: 'dir' });
    expect(dirAgain.statusCode).toBe(409);
  });

  it('rejects sandbox escapes', async () => {
    const res = await post(createUrl(), { path: '../escape.txt', kind: 'file' });
    expect(res.statusCode).toBe(403);
    const putRes = await put(contentUrl(), { path: 'a/../../escape2.txt', content: 'x' });
    expect(putRes.statusCode).toBe(403);
    await expect(fsp.stat(path.join(tmp, 'escape.txt'))).rejects.toBeTruthy();
  });
});

describe('DELETE /files/entry', () => {
  it('deletes files', async () => {
    expect((await post(createUrl(), { path: 'gone.txt', kind: 'file' })).statusCode).toBe(204);
    expect((await del(`${entryUrl()}?path=gone.txt`)).statusCode).toBe(204);
    await expect(fsp.stat(path.join(projectDir, 'gone.txt'))).rejects.toBeTruthy();
    expect((await del(`${entryUrl()}?path=gone.txt`)).statusCode).toBe(404);
  });

  it('refuses non-empty dirs without recursive and deletes with recursive=1', async () => {
    await fsp.mkdir(path.join(projectDir, 'tree', 'inner'), { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'tree', 'inner', 'leaf.txt'), 'leaf');

    const plain = await del(`${entryUrl()}?path=${encodeURIComponent('tree')}`);
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.code).toBe('DIR_NOT_EMPTY');
    expect((await fsp.stat(path.join(projectDir, 'tree'))).isDirectory()).toBe(true);

    const forced = await del(`${entryUrl()}?path=${encodeURIComponent('tree')}&recursive=1`);
    expect(forced.statusCode).toBe(204);
    await expect(fsp.stat(path.join(projectDir, 'tree'))).rejects.toBeTruthy();
  });

  it('deletes an empty dir without recursive', async () => {
    await fsp.mkdir(path.join(projectDir, 'emptydir'));
    expect((await del(`${entryUrl()}?path=emptydir`)).statusCode).toBe(204);
    await expect(fsp.stat(path.join(projectDir, 'emptydir'))).rejects.toBeTruthy();
  });
});

describe('change events from API writes', () => {
  interface Captured {
    event: string;
    payload: { projectId?: string; events?: { type: string; path: string }[] };
  }
  let captured: Captured[] = [];

  beforeAll(() => {
    // Intercept broadcasts: makeBroadcaster reads io.emit at call time, so an
    // own-property patch on the io instance catches everything.
    (io as unknown as { emit: unknown }).emit = (event: string, payload: Captured['payload']) => {
      captured.push({ event, payload });
      return true;
    };
  });

  const filesEvents = (pathFilter: string) =>
    captured
      .filter((c) => c.event === 'files:changed' && c.payload.projectId === projectId)
      .flatMap((c) => c.payload.events ?? [])
      .filter((e) => e.path === pathFilter);

  it('PUT emits create for new files and change for existing ones', async () => {
    await put(contentUrl(), { path: 'watched.txt', content: 'v1' });
    await vi.waitFor(
      () => expect(filesEvents('watched.txt').map((e) => e.type)).toEqual(['create']),
      { timeout: 3000, interval: 25 },
    );
    // Only after the 400 ms batch has flushed does the next write start a new one.
    await put(contentUrl(), { path: 'watched.txt', content: 'v2' });
    await vi.waitFor(
      () => expect(filesEvents('watched.txt').map((e) => e.type)).toEqual(['create', 'change']),
      { timeout: 3000, interval: 25 },
    );
  });

  it('create + DELETE emit create/delete events', async () => {
    await post(createUrl(), { path: 'watched-dir', kind: 'dir' });
    await vi.waitFor(
      () => expect(filesEvents('watched-dir').filter((e) => e.type === 'create').length).toBe(1),
      { timeout: 3000, interval: 25 },
    );
    await del(`${entryUrl()}?path=watched-dir`);
    await vi.waitFor(
      () => expect(filesEvents('watched-dir').filter((e) => e.type === 'delete').length).toBe(1),
      { timeout: 3000, interval: 25 },
    );
  });
});
