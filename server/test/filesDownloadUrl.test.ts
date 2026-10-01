import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;
const PROJECT_ID = 'prj_dl';

function downloadUrl(filePath: string, headers: Record<string, string> = { authorization: `Bearer ${jwt}` }) {
  return app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/files/download-url?path=${encodeURIComponent(filePath)}`,
    headers,
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-dlurl-'));
  const root = path.join(tmp, 'project');
  await fsp.mkdir(path.join(root, 'sub dir'), { recursive: true });
  await fsp.writeFile(path.join(root, 'sub dir', 'notes ü.txt'), 'hello');
  await fsp.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  await deps.store.saveProject({ id: PROJECT_ID, name: 'dl', path: root, createdAt: 1, updatedAt: 1 });
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_test_1', name: 'Test Device' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/projects/:id/files/download-url', () => {
  it('requires a device token', async () => {
    const res = await downloadUrl('data.bin', {});
    expect(res.statusCode).toBe(401);
  });

  it('returns a signed URL that downloads without auth headers', async () => {
    const res = await downloadUrl('data.bin');
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    const file = await app.inject({ method: 'GET', url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(Buffer.from([0, 1, 2, 3]))).toBe(true);
    expect(file.headers['content-disposition']).toBe('attachment; filename="data.bin"');
  });

  it('forces attachment for inline types and handles spaces/unicode in paths', async () => {
    const rel = 'sub dir/notes ü.txt';
    const inline = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/files/raw?path=${encodeURIComponent(rel)}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(String(inline.headers['content-disposition'])).toMatch(/^inline/);

    const res = await downloadUrl(rel);
    expect(res.statusCode).toBe(200);
    const file = await app.inject({ method: 'GET', url: (res.json() as { url: string }).url });
    expect(file.statusCode).toBe(200);
    expect(file.payload).toBe('hello');
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('does not let the token unlock a different file', async () => {
    const res = await downloadUrl('data.bin');
    const { url } = res.json() as { url: string };
    const other = url.replace(encodeURIComponent('data.bin'), encodeURIComponent('sub dir/notes ü.txt'));
    expect((await app.inject({ method: 'GET', url: other })).statusCode).toBe(401);
  });

  it('rejects directories, missing files and paths outside the project', async () => {
    expect((await downloadUrl('sub dir')).statusCode).toBe(400);
    expect((await downloadUrl('nope.txt')).statusCode).toBe(404);
    expect((await downloadUrl('../../etc/passwd')).statusCode).toBeGreaterThanOrEqual(400);
  });
});
