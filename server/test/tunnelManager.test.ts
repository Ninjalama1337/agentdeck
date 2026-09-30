import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging.js';
import {
  MAX_RESTARTS,
  TunnelManager,
  cloudflaredArgs,
  extractTunnelUrl,
  nextRestartDelayMs,
  sawRegisteredConnection,
  wasStable,
} from '../src/tunnel/manager.js';

const OFF_TUNNEL = {
  provider: 'off' as const,
  mode: 'quick' as const,
  token: '',
  name: '',
  credentialsFile: '',
  hostname: '',
  binary: 'cloudflared',
};

/** Recorded-style cloudflared quick-tunnel stderr samples. */
const SAMPLE_BOX = `
2026-09-30T10:00:01.123Z INF Thank you for trying Cloudflare Tunnel. ...
2026-09-30T10:00:01.200Z INF +--------------------------------------------------------------------------------------------+
2026-09-30T10:00:01.200Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-30T10:00:01.200Z INF |  https://crazy-lion-abc123-def.trycloudflare.com                                           |
2026-09-30T10:00:01.200Z INF +--------------------------------------------------------------------------------------------+
`;
const SAMPLE_JSON =
  '{"level":"info","time":"2026-09-30T10:00:02.000Z","msg":"Registered tunnel connection connIndex=1 ip=198.41.200.73 location=ZRH url=https://crazy-lion-abc123-def.trycloudflare.com protocol=http2"}';
const SAMPLE_PLAIN = '2026-09-30 INF Registered tunnel connection connIndex=0';
const SAMPLE_PLAIN_URL = 'https://quick-fox-jumps-high.trycloudflare.com';

describe('tunnel output parsing', () => {
  it('finds the quick-tunnel URL in box-drawn plain output', () => {
    expect(extractTunnelUrl(SAMPLE_BOX)).toBe('https://crazy-lion-abc123-def.trycloudflare.com');
  });

  it('finds the URL inside JSON log lines', () => {
    expect(extractTunnelUrl(SAMPLE_JSON)).toBe('https://crazy-lion-abc123-def.trycloudflare.com');
  });

  it('accepts a bare URL line', () => {
    expect(extractTunnelUrl(`some noise\n${SAMPLE_PLAIN_URL}\n`)).toBe(SAMPLE_PLAIN_URL);
  });

  it('returns undefined when no URL is present', () => {
    expect(extractTunnelUrl('no tunnel url in here')).toBeUndefined();
    expect(extractTunnelUrl('https://example.com/other')).toBeUndefined();
    expect(extractTunnelUrl('')).toBeUndefined();
  });

  it('detects registered tunnel connections', () => {
    expect(sawRegisteredConnection(SAMPLE_JSON)).toBe(true);
    expect(sawRegisteredConnection(SAMPLE_PLAIN)).toBe(true);
    expect(sawRegisteredConnection(SAMPLE_BOX)).toBe(false);
  });
});

describe('restart backoff', () => {
  it('follows the capped schedule 1s,2s,5s,10s,30s', () => {
    expect(nextRestartDelayMs(0)).toBe(1_000);
    expect(nextRestartDelayMs(1)).toBe(2_000);
    expect(nextRestartDelayMs(2)).toBe(5_000);
    expect(nextRestartDelayMs(3)).toBe(10_000);
    expect(nextRestartDelayMs(4)).toBe(30_000);
    expect(nextRestartDelayMs(5)).toBe(30_000);
    expect(nextRestartDelayMs(MAX_RESTARTS)).toBe(30_000);
  });

  it('marks processes stable after 60s so the counter resets', () => {
    expect(wasStable(1_000, 1_000 + 59_999)).toBe(false);
    expect(wasStable(1_000, 1_000 + 60_000)).toBe(true);
  });
});

describe('cloudflaredArgs', () => {
  it('builds quick-mode args against the upstream port', () => {
    expect(cloudflaredArgs({ ...OFF_TUNNEL, provider: 'cloudflared' }, 8787)).toEqual([
      'tunnel',
      '--url',
      'http://127.0.0.1:8787',
      '--no-autoupdate',
    ]);
  });

  it('builds token-mode args (dashboard-managed ingress, no --hostname flag)', () => {
    expect(
      cloudflaredArgs({ ...OFF_TUNNEL, mode: 'token', token: 't0k', hostname: 'deck.example.com' }, 8787),
    ).toEqual(['tunnel', 'run', '--token', 't0k']);
    expect(cloudflaredArgs({ ...OFF_TUNNEL, mode: 'token', token: 't0k' }, 8787)).toEqual([
      'tunnel',
      'run',
      '--token',
      't0k',
    ]);
  });

  it('builds named-mode args: --url to the local server + tunnel name', () => {
    expect(
      cloudflaredArgs(
        { ...OFF_TUNNEL, mode: 'named', name: 'agentdeck', hostname: 'deck.example.com' },
        8787,
      ),
    ).toEqual(['tunnel', 'run', '--url', 'http://127.0.0.1:8787', 'agentdeck']);
    expect(
      cloudflaredArgs(
        {
          ...OFF_TUNNEL,
          mode: 'named',
          name: 'agentdeck',
          credentialsFile: '/home/x/.cloudflared/uuid.json',
        },
        8789,
      ),
    ).toEqual([
      'tunnel',
      'run',
      '--url',
      'http://127.0.0.1:8789',
      '--cred-file',
      '/home/x/.cloudflared/uuid.json',
      'agentdeck',
    ]);
  });
});

describe('TunnelManager basics', () => {
  it('reports disabled and ignores start() when the provider is off', () => {
    const mgr = new TunnelManager({ tunnel: OFF_TUNNEL, dataDir: '/tmp/unused', logger: createLogger('silent') });
    expect(mgr.getInfo()).toEqual({ provider: 'off', status: 'disabled' });
    mgr.start(8787);
    expect(mgr.getInfo().status).toBe('disabled');
  });

  it('exposes starting→info before any cloudflared runs', () => {
    const mgr = new TunnelManager({
      tunnel: { ...OFF_TUNNEL, provider: 'cloudflared' },
      dataDir: '/tmp/unused',
      logger: createLogger('silent'),
    });
    expect(mgr.getInfo()).toEqual({ provider: 'cloudflared', status: 'starting' });
  });
});
