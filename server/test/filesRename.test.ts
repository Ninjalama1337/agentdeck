import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Attachment, FileInfoResponse } from '@agentdeck/shared';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { permissionString } from '../src/routes/filesEdit.js';

let tmp = '';
let root = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;
const PROJECT_ID = 'prj_rename';

const auth = () => ({ authorization: `Bearer ${jwt}` });
const rename = (from: string, to: string) =>
  app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/files/rename`, headers: auth(), payload: { from, to } });
const info = (p: string) =>
  app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/files/info?path=${encodeURIComponent(p)}`, headers: auth() });

function upload(query: string, filename: string, body: string) {
  const boundary = '----agentdeck-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(body),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/files/upload?${query}`,
    headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-rename-'));
  root = path.join(tmp, 'project');
  await fsp.mkdir(root, { recursive: true });
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  await deps.store.saveProject({ id: PROJECT_ID, name: 'rename', path: root, createdAt: 1, updatedAt: 1 });
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_rename_1', name: 'Rename Test' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('POST /files/rename', () => {
  it('renames a file and refuses to overwrite', async () => {
    await fsp.writeFile(path.join(root, 'a.txt'), 'A');
    await fsp.writeFile(path.join(root, 'b.txt'), 'B');
    expect((await rename('a.txt', 'b.txt')).statusCode).toBe(409);
    const res = await rename('a.txt', 'docs/c.txt');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'docs/c.txt' });
    expect(await fsp.readFile(path.join(root, 'docs/c.txt'), 'utf8')).toBe('A');
    await expect(fsp.access(path.join(root, 'a.txt'))).rejects.toThrow();
  });

  it('renames a symlink itself, not its target', async () => {
    await fsp.writeFile(path.join(root, 'target.txt'), 'T');
    await fsp.symlink('target.txt', path.join(root, 'link.txt'));
    expect((await rename('link.txt', 'link2.txt')).statusCode).toBe(200);
    expect(await fsp.readlink(path.join(root, 'link2.txt'))).toBe('target.txt');
    expect(await fsp.readFile(path.join(root, 'target.txt'), 'utf8')).toBe('T');
  });

  it('rejects .git, escapes, missing sources and moves into itself', async () => {
    await fsp.mkdir(path.join(root, 'dir'), { recursive: true });
    expect((await rename('b.txt', '.git/b.txt')).statusCode).toBe(403);
    expect((await rename('b.txt', '../b.txt')).statusCode).toBe(403);
    expect((await rename('nope.txt', 'x.txt')).statusCode).toBe(404);
    expect((await rename('dir', 'dir/sub')).statusCode).toBe(400);
  });
});

describe('GET /files/info', () => {
  it('describes files, folders and links', async () => {
    const file = (await info('b.txt')).json() as FileInfoResponse;
    expect(file).toMatchObject({ path: 'b.txt', name: 'b.txt', kind: 'file', size: 1, mime: 'text/plain; charset=utf-8' });
    expect(file.absPath).toBe(path.join(await fsp.realpath(root), 'b.txt'));
    expect(file.permissions).toMatch(/^[r-][w-][x-]{1}[r-][w-][x-][r-][w-][x-]$/);

    const dir = (await info('docs')).json() as FileInfoResponse;
    expect(dir).toMatchObject({ kind: 'dir', items: 1 });

    const link = (await info('link2.txt')).json() as FileInfoResponse;
    expect(link).toMatchObject({ kind: 'file', symlinkTarget: 'target.txt' });

    expect((await info('missing')).statusCode).toBe(404);
  });

  it('formats permission bits', () => {
    expect(permissionString(0o100644)).toBe('rw-r--r--');
    expect(permissionString(0o40755)).toBe('rwxr-xr-x');
  });
});

describe('POST /files/upload?name=', () => {
  it('saves under the chosen name, refuses collisions unless overwrite=1', async () => {
    const first = await upload('dir=in&name=Bericht%20final.txt', 'raw.txt', 'one');
    expect(first.statusCode).toBe(201);
    expect((first.json() as Attachment).name).toBe('Bericht final.txt');
    expect(await fsp.readFile(path.join(root, 'in', 'Bericht final.txt'), 'utf8')).toBe('one');

    const clash = await upload('dir=in&name=Bericht%20final.txt', 'raw.txt', 'two');
    expect(clash.statusCode).toBe(409);
    expect(await fsp.readFile(path.join(root, 'in', 'Bericht final.txt'), 'utf8')).toBe('one');

    const replaced = await upload('dir=in&name=Bericht%20final.txt&overwrite=1', 'raw.txt', 'two');
    expect(replaced.statusCode).toBe(201);
    expect(await fsp.readFile(path.join(root, 'in', 'Bericht final.txt'), 'utf8')).toBe('two');
    // No temp leftovers next to it.
    expect(await fsp.readdir(path.join(root, 'in'))).toEqual(['Bericht final.txt']);
  });

  it('keeps the id prefix without a name (older apps)', async () => {
    const res = await upload('dir=in', 'old.txt', 'x');
    expect(res.statusCode).toBe(201);
    const names = await fsp.readdir(path.join(root, 'in'));
    expect(names.some((n) => /__old\.txt$/.test(n))).toBe(true);
  });
});
