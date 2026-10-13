import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Attachment } from '@agentdeck/shared';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let root = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;
const PROJECT_ID = 'prj_termup';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function upload(query: string, filename: string) {
  const boundary = '----agentdeck-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT_ID}/files/upload?${query}`,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-termup-'));
  root = path.join(tmp, 'project');
  await fsp.mkdir(root, { recursive: true });
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  await deps.store.saveProject({ id: PROJECT_ID, name: 'termup', path: root, createdAt: 1, updatedAt: 1 });
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_test_1', name: 'Test Device' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/projects/:id/files/upload?terminalId=', () => {
  it('rejects an unknown terminal', async () => {
    const res = await upload('terminalId=t_nope', 'shot.png');
    expect(res.statusCode).toBe(404);
  });

  it('stores the file outside the project, returns a path a prompt takes as one word, and drops it with the terminal', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { projectId: PROJECT_ID },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { terminal: { id: string } }).terminal.id;

    const res = await upload(`terminalId=${id}&dir=uploads`, 'Screen shot (1) ü.png');
    expect(res.statusCode).toBe(201);
    const att = res.json() as Attachment;
    expect(att.kind).toBe('image');
    expect(att.path).toBeTruthy();
    const file = att.path as string;
    expect(file.startsWith(deps.store.attachmentsRoot + path.sep)).toBe(true);
    expect(path.basename(file)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect((await fsp.readFile(file)).equals(PNG)).toBe(true);
    // Nothing lands in the project.
    expect(await fsp.readdir(root)).toEqual([]);

    const killed = await app.inject({ method: 'DELETE', url: `/api/terminals/${id}`, headers: { authorization: `Bearer ${jwt}` } });
    expect(killed.statusCode).toBe(204);
    await expect.poll(() => fsp.access(file).then(() => true, () => false)).toBe(false);
  });
});
