import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, SessionDetailResponse } from '@agentdeck/shared';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;
let sessionId = '';
const ids = ['m_1', 'm_2', 'm_3'];

function detail(query = '', headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}${query}`,
    headers: { authorization: `Bearer ${jwt}`, ...headers },
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-detail-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  await deps.store.saveProject({ id: 'p_detail', name: 'd', path: path.join(tmp, 'project'), createdAt: 1, updatedAt: 1 });
  const session = await deps.store.newSession({ projectId: 'p_detail', agentId: 'claude' });
  sessionId = session.id;
  for (const [i, id] of ids.entries()) {
    const message: ChatMessage = {
      id,
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `message ${i} `.repeat(60),
      attachments: [],
      ts: 1000 + i,
    };
    await deps.store.appendMessage(message);
  }
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_test_1', name: 'Test Device' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('PATCH /api/sessions/:id', () => {
  it('persists the picked model and clears it back to the agent default', async () => {
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { model: 'opencode-go/glm-5.3' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { model?: string }).model).toBe('opencode-go/glm-5.3');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { model: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { model?: string }).model).toBeUndefined();
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns the whole history and no draft while nothing runs', async () => {
    const body = (await detail()).json() as SessionDetailResponse;
    expect(body.messages.map((m) => m.id)).toEqual(ids);
    expect(body.draft).toBeNull();
    expect(body.partial).toBeUndefined();
  });

  it('returns only what is newer than `after`', async () => {
    const body = (await detail('?after=m_1')).json() as SessionDetailResponse;
    expect(body.messages.map((m) => m.id)).toEqual(['m_2', 'm_3']);
    expect(body.partial).toBe(true);

    const upToDate = (await detail('?after=m_3')).json() as SessionDetailResponse;
    expect(upToDate.messages).toEqual([]);
    expect(upToDate.partial).toBe(true);
  });

  it('falls back to the whole history for an id it does not know', async () => {
    const body = (await detail('?after=m_gone')).json() as SessionDetailResponse;
    expect(body.messages.map((m) => m.id)).toEqual(ids);
    expect(body.partial).toBeUndefined();
  });
});

describe('gzip for API answers', () => {
  it('compresses JSON for clients that accept it', async () => {
    const plain = await detail();
    const zipped = await detail('', { 'accept-encoding': 'gzip, deflate, br' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
    expect(Number(zipped.headers['content-length'])).toBe(zipped.rawPayload.length);
    expect(zlib.gunzipSync(zipped.rawPayload).toString('utf8')).toBe(plain.payload);
  });

  it('leaves small answers and file streams alone', async () => {
    const small = await app.inject({ method: 'GET', url: '/api/health', headers: { 'accept-encoding': 'gzip' } });
    expect(small.headers['content-encoding']).toBeUndefined();

    const file = path.join(tmp, 'project', 'big.txt');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'line of text\n'.repeat(500));
    const raw = await app.inject({
      method: 'GET',
      url: '/api/projects/p_detail/files/raw?path=big.txt',
      headers: { authorization: `Bearer ${jwt}`, 'accept-encoding': 'gzip' },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-encoding']).toBeUndefined();
    expect(raw.payload).toBe('line of text\n'.repeat(500));
  });
});
