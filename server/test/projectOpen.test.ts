import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../src/routes/deps.js';
import type { BrowseResponse, Project } from '@agentdeck/shared';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let root = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });
}
function post(url: string, body: unknown) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${jwt}` }, payload: body });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-open-'));
  root = path.join(tmp, 'root');
  await fsp.mkdir(path.join(root, 'alpha', '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'beta'), { recursive: true });
  await fsp.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fsp.writeFile(path.join(root, 'file.txt'), 'x');

  const config = loadConfig({
    env: { AGENTDECK_DATA_DIR: path.join(tmp, 'data'), AGENTDECK_TUNNEL: 'off', AGENTDECK_BROWSE_ROOT: root },
    configDir: path.join(tmp, 'none'),
  });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_open_1', name: 'Open Test' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/fs/browse', () => {
  it('lists directories under the root, hides dot-dirs, flags git repos', async () => {
    const res = await get('/api/fs/browse');
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseResponse;
    expect(body.path).toBe(await fsp.realpath(root));
    const names = body.entries.map((e) => e.name);
    expect(names).toEqual(['alpha', 'beta']); // git repo sorted first
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('file.txt');
    expect(body.entries[0]).toMatchObject({ name: 'alpha', isGitRepo: true });
    expect(body.parent).toBeUndefined();
  });

  it('navigates into a subdirectory and reports its parent', async () => {
    const res = await get(`/api/fs/browse?path=${encodeURIComponent(path.join(root, 'alpha'))}`);
    const body = res.json() as BrowseResponse;
    expect(body.path).toBe(await fsp.realpath(path.join(root, 'alpha')));
    expect(body.parent).toBe(await fsp.realpath(root));
    expect(body.entries).toEqual([]);
  });

  it('includes dot-dirs with all=1', async () => {
    const res = await get('/api/fs/browse?all=1');
    const body = res.json() as BrowseResponse;
    expect(body.entries.map((e) => e.name)).toContain('.hidden');
  });

  it('rejects traversal and absolute paths outside the root', async () => {
    expect((await get('/api/fs/browse?path=..')).statusCode).toBe(403);
    expect((await get(`/api/fs/browse?path=${encodeURIComponent('/etc')}`)).statusCode).toBe(403);
  });
});

describe('POST /api/projects/open', () => {
  it('adopts an existing directory as a project', async () => {
    const res = await post('/api/projects/open', { path: path.join(root, 'beta') });
    expect(res.statusCode).toBe(201);
    const project = res.json() as Project;
    expect(project.name).toBe('beta');
    expect(project.path).toBe(await fsp.realpath(path.join(root, 'beta')));
  });

  it('returns the already-registered project instead of duplicating', async () => {
    const first = (await post('/api/projects/open', { path: path.join(root, 'beta') })).json() as Project;
    const res = await post('/api/projects/open', { path: path.join(root, 'beta') });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Project).id).toBe(first.id);
  });

  it('uses a custom name when given', async () => {
    const res = await post('/api/projects/open', { path: path.join(root, 'alpha'), name: 'Custom' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as Project).name).toBe('Custom');
  });

  it('rejects files, missing dirs and paths outside the root', async () => {
    expect((await post('/api/projects/open', { path: path.join(root, 'file.txt') })).statusCode).toBe(400);
    expect((await post('/api/projects/open', { path: path.join(root, 'nope') })).statusCode).toBe(404);
    expect((await post('/api/projects/open', { path: '/etc' })).statusCode).toBe(403);
  });
});
