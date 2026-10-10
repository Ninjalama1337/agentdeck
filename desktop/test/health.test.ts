import { describe, expect, it } from 'vitest';
import { connectHost, createHealthProbe, originOf, urlHost, waitForHealth, type FetchLike, type HealthProbe } from '../src/core/health';

const ok = (body: unknown, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const fail = (code: string | undefined, name = 'TypeError'): Promise<never> => {
  const err = Object.assign(new Error('fetch failed'), { name, ...(code ? { cause: { code } } : {}) });
  return Promise.reject(err);
};

describe('createHealthProbe', () => {
  it('recognizes AgentDeck by its health answer', async () => {
    const probe = createHealthProbe({ fetch: () => ok({ ok: true, name: 'agentdeck', version: '1.2.3', agents: [] }) });
    expect(await probe('http://127.0.0.1:1')).toEqual({ state: 'agentdeck', version: '1.2.3' });
  });

  it('requests the public health route', async () => {
    const urls: string[] = [];
    const probe = createHealthProbe({ fetch: (url) => { urls.push(url); return ok({ ok: true, name: 'agentdeck' }); } });
    await probe('http://127.0.0.1:4317');
    expect(urls).toEqual(['http://127.0.0.1:4317/api/health']);
  });

  it('calls anything else that answers foreign', async () => {
    expect(await createHealthProbe({ fetch: () => ok({ ok: true, name: 'nginx' }) })('http://x')).toEqual({ state: 'foreign' });
    expect(await createHealthProbe({ fetch: () => ok({}, 404) })('http://x')).toEqual({ state: 'foreign' });
    expect(await createHealthProbe({ fetch: () => ok(null) })('http://x')).toEqual({ state: 'foreign' });
    expect(await createHealthProbe({ fetch: () => fail('UND_ERR_SOCKET') })('http://x')).toEqual({ state: 'foreign' });
    expect(await createHealthProbe({ fetch: () => fail(undefined) })('http://x')).toEqual({ state: 'foreign' });
  });

  it('maps refused connections to closed and timeouts to unresponsive', async () => {
    expect(await createHealthProbe({ fetch: () => fail('ECONNREFUSED') })('http://x')).toEqual({ state: 'closed' });
    expect(await createHealthProbe({ fetch: () => fail(undefined, 'TimeoutError') })('http://x')).toEqual({ state: 'unresponsive' });
    expect(await createHealthProbe({ fetch: () => fail(undefined, 'AbortError') })('http://x')).toEqual({ state: 'unresponsive' });
  });
});

describe('addresses', () => {
  it('connects to loopback for wildcard and loopback binds, to the address otherwise', () => {
    expect(connectHost('0.0.0.0')).toBe('127.0.0.1');
    expect(connectHost('::')).toBe('127.0.0.1');
    expect(connectHost('localhost')).toBe('127.0.0.1');
    expect(connectHost('127.0.0.1')).toBe('127.0.0.1');
    expect(connectHost('192.168.1.5')).toBe('192.168.1.5');
    expect(urlHost('fe80::1')).toBe('[fe80::1]');
    expect(originOf('0.0.0.0', 4317)).toBe('http://127.0.0.1:4317');
    expect(originOf('192.168.1.5', 80)).toBe('http://192.168.1.5:80');
  });
});

describe('waitForHealth', () => {
  it('polls until done and gives up at the deadline', async () => {
    let clock = 0;
    const answers: HealthProbe[] = [{ state: 'closed' }, { state: 'closed' }, { state: 'agentdeck' }];
    const deps = {
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    };
    const done = await waitForHealth({ ...deps, probe: async () => answers.shift() as HealthProbe, done: (p) => p.state === 'agentdeck', timeoutMs: 5000, intervalMs: 100 });
    expect(done).toEqual({ ok: true, probe: { state: 'agentdeck' } });
    expect(clock).toBe(200);

    clock = 0;
    const never = await waitForHealth({ ...deps, probe: async () => ({ state: 'closed' }), done: () => false, timeoutMs: 1000, intervalMs: 300 });
    expect(never.ok).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(1000);
  });
});
