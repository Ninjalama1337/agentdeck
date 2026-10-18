import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ModelPreset } from '@agentdeck/shared';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';
let app: FastifyInstance;
let jwt = '';
let modelsFor: ReturnType<typeof vi.fn>;

/** A catalog large enough that the gzip onSend hook actually compresses it. */
const MODELS: ModelPreset[] = Array.from({ length: 60 }, (_, i) => ({
  id: `opencode-go/model-${i}`,
  label: `Model ${i}`,
  description: `opencode-go/model-${i}`,
  provider: 'opencode-go',
}));

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-modelsroute-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  jwt = await signDeviceToken(built.deps.jwtSecret, { deviceId: 'dev_models_1', name: 'Models Test' });
  // The catalog read spawns opencode; for the route contract it is stubbed.
  modelsFor = vi.fn(async () => ({ models: MODELS, defaultModel: MODELS[0] }));
  (built.deps.agents as unknown as { modelsFor: unknown }).modelsFor = modelsFor;
});

afterAll(async () => {
  await app.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/models/:agentId', () => {
  it('answers with the provider catalog as gzipped JSON (no double send)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/models/opencode?path=%2Ftmp',
      headers: { authorization: `Bearer ${jwt}`, 'accept-encoding': 'gzip, deflate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // The body must survive the gzip onSend hook: a bare reply.send() in the
    // async handler raced it into a second writeHead and a broken body.
    const json = JSON.parse(zlib.gunzipSync(res.rawPayload).toString('utf8')) as {
      models: ModelPreset[];
      defaultModel?: ModelPreset;
    };
    expect(json.models).toHaveLength(MODELS.length);
    expect(json.models[0]?.id).toBe('opencode-go/model-0');
    expect(json.defaultModel?.id).toBe('opencode-go/model-0');
    expect(modelsFor).toHaveBeenCalledWith('opencode', '/tmp');
  });
});
