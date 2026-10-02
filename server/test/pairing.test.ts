import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';

let tmp = '';
let app: FastifyInstance;
let deps: AppDeps;

const pair = (code: string, opts: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/pair',
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: opts.headers ?? {},
    payload: { code, deviceName: 'Pairing Test' },
  });

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-pairing-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/pair is LAN-only', () => {
  it('refuses the correct code when it arrives through a tunnel', async () => {
    const code = deps.pairingCode;
    const tunneled = await pair(code, { headers: { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' } });
    expect(tunneled.statusCode).toBe(403);
    expect(tunneled.json().error.code).toBe('FORBIDDEN');

    // A LAN address the client prepends does not help: the proxy appends the real one.
    const spoofed = await pair(code, { headers: { 'x-forwarded-for': '192.168.1.5, 203.0.113.9' } });
    expect(spoofed.statusCode).toBe(403);

    // Refused requests neither consume the code nor count as failed attempts.
    expect(deps.pairingCode).toBe(code);
  });

  it('refuses a public socket peer', async () => {
    const res = await pair(deps.pairingCode, { remoteAddress: '203.0.113.9' });
    expect(res.statusCode).toBe(403);
  });

  it('lets a LAN client behind a local reverse proxy through to the code check', async () => {
    const res = await pair('000000x', { headers: { 'x-forwarded-for': '192.168.1.5' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CODE');
  });

  it('pairs a direct LAN client and rotates the code', async () => {
    const code = deps.pairingCode;
    const res = await pair(code, { remoteAddress: '192.168.1.7' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');
    expect(deps.pairingCode).not.toBe(code);
  });
});

describe('GET /api/server', () => {
  it('needs a paired device and returns the same identity pairing reported', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/server' })).statusCode).toBe(401);

    const paired = (await pair(deps.pairingCode)).json();
    const res = await app.inject({ method: 'GET', url: '/api/server', headers: { authorization: `Bearer ${paired.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(paired.server);
    expect(res.json().name).toBe(deps.config.serverName);
  });
});
