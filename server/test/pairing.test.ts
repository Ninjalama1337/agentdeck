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

const TUNNEL = { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' };

describe('POST /api/pair before any device is paired', () => {
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

describe('POST /api/pair from outside the network', () => {
  const authed = (token: string) => ({ authorization: `Bearer ${token}` });
  const status = (id: string, pollToken: string) =>
    app.inject({ method: 'POST', url: '/api/pair/status', payload: { id, pollToken } });
  const decide = (token: string, id: string, approve: boolean) =>
    app.inject({ method: 'POST', url: `/api/pair/requests/${id}`, headers: authed(token), payload: { approve } });

  it('waits for a paired device to approve, then hands out the token once', async () => {
    const phone = (await pair(deps.pairingCode)).json().token as string;
    const code = deps.pairingCode;

    const res = await pair(code, { headers: TUNNEL });
    expect(res.statusCode).toBe(202);
    const { pending } = res.json();
    expect(res.json().token).toBeUndefined();
    expect(deps.pairingCode).not.toBe(code);

    expect((await status(pending.id, pending.pollToken)).json()).toEqual({ status: 'pending' });
    expect((await status(pending.id, 'wrong')).json()).toEqual({ status: 'gone' });

    const listed = (await app.inject({ method: 'GET', url: '/api/pair/requests', headers: authed(phone) })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: pending.id, deviceName: 'Pairing Test', ip: '203.0.113.9', checkCode: pending.checkCode });
    expect(listed[0].pollToken).toBeUndefined();

    expect((await decide(phone, pending.id, true)).statusCode).toBe(204);
    const approved = (await status(pending.id, pending.pollToken)).json();
    expect(approved.status).toBe('approved');
    const me = await app.inject({ method: 'GET', url: '/api/server', headers: authed(approved.token) });
    expect(me.statusCode).toBe(200);

    expect((await status(pending.id, pending.pollToken)).json()).toEqual({ status: 'gone' });
    expect((await decide(phone, pending.id, true)).statusCode).toBe(404);
  });

  it('gives a denied request nothing', async () => {
    const phone = (await pair(deps.pairingCode)).json().token as string;
    const { pending } = (await pair(deps.pairingCode, { headers: TUNNEL })).json();
    expect((await decide(phone, pending.id, false)).statusCode).toBe(204);
    expect((await status(pending.id, pending.pollToken)).json()).toEqual({ status: 'gone' });
  });

  it('only lets paired devices decide, read the code or ask for a new one', async () => {
    const { pending } = (await pair(deps.pairingCode, { headers: TUNNEL })).json();
    const open = await app.inject({ method: 'POST', url: `/api/pair/requests/${pending.id}`, payload: { approve: true } });
    expect(open.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/pair/code' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/pair/code' })).statusCode).toBe(401);
    expect((await status(pending.id, pending.pollToken)).json()).toEqual({ status: 'pending' });

    const phone = (await pair(deps.pairingCode)).json().token as string;
    const shown = (await app.inject({ method: 'GET', url: '/api/pair/code', headers: authed(phone) })).json().code;
    expect(shown).toBe(deps.pairingCode);
    const fresh = (await app.inject({ method: 'POST', url: '/api/pair/code', headers: authed(phone) })).json().code;
    expect(fresh).toMatch(/^\d{6}$/);
    expect(deps.pairingCode).toBe(fresh);
    expect((await pair(shown, { remoteAddress: '192.168.1.8' })).statusCode).toBe(fresh === shown ? 200 : 401);
  });

  it('stops guessing from outside after 10 wrong codes, whatever address they claim', async () => {
    let last = 0;
    for (let i = 0; i <= 10; i++) {
      last = (await pair('000000x', { headers: { 'x-forwarded-for': `203.0.113.${100 + i}` } })).statusCode;
    }
    expect(last).toBe(429);
    // The local network is not locked out along with them.
    expect((await pair(deps.pairingCode, { remoteAddress: '192.168.1.9' })).statusCode).toBe(200);
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
