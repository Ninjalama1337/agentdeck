import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AGENT_IDS } from '@agentdeck/shared';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let app: FastifyInstance;
let jwt = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-agentid-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  await built.deps.store.saveProject({
    id: 'p_agents',
    name: 'agents',
    path: path.join(tmp, 'project'),
    createdAt: 1,
    updatedAt: 1,
  });
  jwt = await signDeviceToken(built.deps.jwtSecret, { deviceId: 'dev_agents_1', name: 'Agents Test' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

function createSession(agentId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { projectId: 'p_agents', agentId },
  });
}

describe('agent id validation', () => {
  it('accepts every canonical agent id — opencode included', async () => {
    for (const agentId of AGENT_IDS) {
      const res = await createSession(agentId);
      expect(res.statusCode, `${agentId}: ${res.payload}`).toBe(201);
    }
  });

  it('rejects an unknown agent id', async () => {
    const res = await createSession('gemini');
    expect(res.statusCode).toBe(400);
  });
});
