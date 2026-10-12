import { describe, expect, it } from 'vitest';
import {
  createPairingCoordinator,
  deviceName,
  pairWithLocalServer,
  parsePairingCode,
  type PairDeps,
  type PairOutcome,
} from '../src/core/pairing';
import {
  activeIsLocal,
  applyPairing,
  isLocalBase,
  localToken,
  parseServers,
  planPairing,
  SERVERS_KEY,
  type StorageSnapshot,
} from '../src/core/storagePairing';

const ORIGIN = 'http://127.0.0.1:4317';

describe('device name and code', () => {
  it('names the device "<hostname> (Desktop)" within 64 characters', () => {
    expect(deviceName('mybox')).toBe('mybox (Desktop)');
    expect(deviceName('').endsWith(' (Desktop)')).toBe(true);
    expect(deviceName('x'.repeat(100))).toHaveLength(64);
  });

  it('accepts exactly six digits', () => {
    expect(parsePairingCode('123456\n')).toBe('123456');
    expect(parsePairingCode('12345')).toBeNull();
    expect(parsePairingCode('abcdef')).toBeNull();
    expect(parsePairingCode('')).toBeNull();
  });
});

function pairDeps(responses: Array<{ status: number; body: unknown } | Error>, codes: string[] = ['111111', '222222']): { deps: PairDeps; sent: Array<{ url: string; body: unknown }> } {
  const sent: Array<{ url: string; body: unknown }> = [];
  const remaining = [...codes];
  return {
    sent,
    deps: {
      baseUrl: ORIGIN,
      codeFile: '/data/pairing-code.txt',
      name: 'box (Desktop)',
      // the code is read fresh for every attempt
      readFile: async () => `${remaining.shift() ?? '999999'}\n`,
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        if (next instanceof Error) throw next;
        return { status: next.status, json: async () => next.body };
      },
    },
  };
}

describe('pairWithLocalServer', () => {
  it('trades the code for a token', async () => {
    const { deps, sent } = pairDeps([{ status: 200, body: { token: 'jwt', server: { name: 'deck', version: '1', host: 'h' } } }]);
    expect(await pairWithLocalServer(deps)).toEqual({ ok: true, token: 'jwt', serverName: 'deck' });
    expect(sent).toEqual([{ url: `${ORIGIN}/api/pair`, body: { code: '111111', deviceName: 'box (Desktop)' } }]);
  });

  it('reads the code again once when it rotated in between', async () => {
    const { deps, sent } = pairDeps([
      { status: 401, body: { error: { code: 'INVALID_CODE', message: 'Invalid pairing code.' } } },
      { status: 200, body: { token: 'jwt', server: { name: 'deck' } } },
    ]);
    expect((await pairWithLocalServer(deps)).ok).toBe(true);
    expect(sent.map((s) => (s.body as { code: string }).code)).toEqual(['111111', '222222']);
  });

  it('gives up after a second rejection and reports the server message', async () => {
    const { deps } = pairDeps([
      { status: 401, body: { error: { message: 'Invalid pairing code.' } } },
      { status: 401, body: { error: { message: 'Invalid pairing code.' } } },
    ]);
    expect(await pairWithLocalServer(deps)).toEqual({ ok: false, reason: 'Invalid pairing code.' });
  });

  it('explains a missing code file, an unusable code, a refused connection and an approval request', async () => {
    const unreadable = pairDeps([]);
    unreadable.deps.readFile = async () => {
      throw new Error('EACCES');
    };
    expect(await pairWithLocalServer(unreadable.deps)).toMatchObject({ ok: false, reason: expect.stringContaining('Cannot read the pairing code') });

    const garbled = pairDeps([], ['nope']);
    expect(await pairWithLocalServer(garbled.deps)).toMatchObject({ ok: false, reason: expect.stringContaining('empty') });

    expect(await pairWithLocalServer(pairDeps([new Error('ECONNREFUSED')]).deps)).toMatchObject({ ok: false, reason: expect.stringContaining('ECONNREFUSED') });
    expect(await pairWithLocalServer(pairDeps([{ status: 202, body: { pending: { id: 'x' } } }]).deps)).toMatchObject({ ok: false, reason: expect.stringContaining('approved') });
    expect(await pairWithLocalServer(pairDeps([{ status: 429, body: {} }]).deps)).toEqual({ ok: false, reason: 'HTTP 429' });
  });
});

describe('createPairingCoordinator', () => {
  const ok: PairOutcome = { ok: true, token: 'jwt-1', serverName: 'deck' };

  it('shares one attempt between simultaneous requests', async () => {
    let calls = 0;
    const c = createPairingCoordinator({ now: () => 0, pair: async () => { calls += 1; return ok; } });
    const [a, b] = await Promise.all([c.request(), c.request()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(c.lastToken()).toBe('jwt-1');
  });

  it('stops re-pairing when the server keeps rejecting the token', async () => {
    let clock = 0;
    let calls = 0;
    const c = createPairingCoordinator({ now: () => clock, max: 3, windowMs: 1000, pair: async () => { calls += 1; return ok; } });
    for (let i = 0; i < 3; i++) expect((await c.request()).ok).toBe(true);
    expect(await c.request()).toMatchObject({ ok: false, reason: expect.stringContaining('too often') });
    expect(calls).toBe(3);
    clock = 2000;
    expect((await c.request()).ok).toBe(true);
  });

  it('does not count failed attempts and returns them as they are', async () => {
    let calls = 0;
    const c = createPairingCoordinator({ now: () => 0, max: 1, pair: async () => { calls += 1; return { ok: false, reason: 'nope' }; } });
    expect(await c.request()).toEqual({ ok: false, reason: 'nope' });
    expect(await c.request()).toEqual({ ok: false, reason: 'nope' });
    expect(calls).toBe(2);
    expect(c.lastToken()).toBeNull();
  });
});

const snap = (servers: unknown, legacyToken: string | null = null): StorageSnapshot => ({
  servers: servers === null ? null : JSON.stringify(servers),
  legacyToken,
});
const profile = (patch: object = {}) => ({ id: 'default', name: '', base: '', token: null, ...patch });

describe('planPairing (localStorage format of web/src/api/servers.ts)', () => {
  it('pairs a fresh profile', () => {
    expect(planPairing(snap(null), ORIGIN)).toEqual({ action: 'pair' });
  });

  it('leaves a legacy token to the web app to migrate', () => {
    expect(planPairing(snap(null, 'old-jwt'), ORIGIN)).toEqual({ action: 'none' });
  });

  it('pairs an unpaired local profile and keeps a paired one', () => {
    expect(planPairing(snap({ servers: [profile()], activeId: 'default' }), ORIGIN)).toEqual({ action: 'pair' });
    expect(planPairing(snap({ servers: [profile({ token: 'jwt' })], activeId: 'default' }), ORIGIN)).toEqual({ action: 'none' });
    expect(planPairing(snap({ servers: [profile({ base: ORIGIN })], activeId: 'default' }), ORIGIN)).toEqual({ action: 'pair' });
    expect(planPairing(snap({ servers: [profile({ base: `${ORIGIN}/` })], activeId: 'default' }), ORIGIN)).toEqual({ action: 'pair' });
  });

  it('does not interfere when the user switched to another saved server', () => {
    const state = { servers: [profile({ token: 'jwt' }), profile({ id: 's2', base: 'http://nas:4317', token: null })], activeId: 's2' };
    expect(planPairing(snap(state), ORIGIN)).toEqual({ action: 'none' });
    expect(activeIsLocal(snap(state), ORIGIN)).toBe(false);
    expect(activeIsLocal(snap({ ...state, activeId: 'default' }), ORIGIN)).toBe(true);
  });

  it('treats a state the web app would reject as absent', () => {
    expect(planPairing({ servers: '{nope', legacyToken: null }, ORIGIN)).toEqual({ action: 'pair' });
    expect(planPairing({ servers: JSON.stringify({ servers: [] }), legacyToken: null }, ORIGIN)).toEqual({ action: 'pair' });
    expect(parseServers(JSON.stringify({ servers: [{ id: 'x' }] }))).toBeNull();
  });

  it('recognizes local bases', () => {
    expect(isLocalBase('', ORIGIN)).toBe(true);
    expect(isLocalBase(ORIGIN, ORIGIN)).toBe(true);
    expect(isLocalBase('http://localhost:4317', ORIGIN)).toBe(false);
    expect(isLocalBase('http://nas:4317', ORIGIN)).toBe(false);
  });
});

describe('applyPairing', () => {
  const login = { token: 'jwt-new', serverName: 'deck' };

  it('writes the exact shape the web app reads for a fresh profile', () => {
    const next = JSON.parse(applyPairing(snap(null), ORIGIN, login));
    expect(next).toEqual({ servers: [{ id: 'default', name: 'deck', base: '', token: 'jwt-new' }], activeId: 'default' });
    // and the web app's own validation accepts it
    expect(parseServers(JSON.stringify(next))).toEqual(next);
  });

  it('fills the token into the active local profile and keeps everything else', () => {
    const state = { servers: [profile({ token: 'dead' }), profile({ id: 's2', name: 'nas', base: 'http://nas:4317', token: 'nas-jwt' })], activeId: 'default' };
    const next = JSON.parse(applyPairing(snap(state), ORIGIN, login));
    expect(next.activeId).toBe('default');
    expect(next.servers[0]).toEqual({ id: 'default', name: 'deck', base: '', token: 'jwt-new' });
    expect(next.servers[1]).toEqual(state.servers[1]);
  });

  it('never writes the token into a remote server profile', () => {
    const state = { servers: [profile({ token: 'jwt' }), profile({ id: 's2', base: 'http://nas:4317' })], activeId: 's2' };
    const next = JSON.parse(applyPairing(snap(state), ORIGIN, login));
    expect(next.servers[1].token).toBeNull();
  });
});

describe('localToken', () => {
  it('finds the login of the window\'s own server', () => {
    const state = { servers: [profile({ token: 'local' }), profile({ id: 's2', base: 'http://nas:4317', token: 'nas' })], activeId: 's2' };
    expect(localToken(JSON.stringify(state), ORIGIN)).toBe('local');
    expect(localToken(JSON.stringify({ servers: [profile()], activeId: 'default' }), ORIGIN)).toBeNull();
    expect(localToken(null, ORIGIN)).toBeNull();
  });

  it('uses the same storage key as the web app', () => {
    expect(SERVERS_KEY).toBe('agentdeck:servers');
  });
});
