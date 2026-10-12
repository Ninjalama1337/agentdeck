/** What answers on the server's port. */
export type HealthProbe =
  /** An AgentDeck server (its public `GET /api/health`). */
  | { state: 'agentdeck'; version?: string }
  /** Something else answers (another program on our port). */
  | { state: 'foreign' }
  /** Connected but no answer in time — busy or hung; not safe to assume either way. */
  | { state: 'unresponsive' }
  /** Nothing listens. */
  | { state: 'closed' };

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const CLOSED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** `host` as it goes into a URL (IPv6 literals need brackets). */
export function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Address the app connects to for a bind address: wildcard and loopback names mean 127.0.0.1. */
export function connectHost(bindHost: string): string {
  const host = bindHost.trim().toLowerCase();
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost' || host === '::1') {
    return '127.0.0.1';
  }
  return bindHost.trim();
}

export function originOf(host: string, port: number): string {
  return `http://${urlHost(connectHost(host))}:${port}`;
}

export function createHealthProbe(options: {
  fetch: FetchLike;
  timeoutMs?: number;
}): (baseUrl: string) => Promise<HealthProbe> {
  const timeoutMs = options.timeoutMs ?? 2500;
  return async (baseUrl) => {
    try {
      const res = await options.fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { state: 'foreign' };
      const body = (await res.json()) as { ok?: unknown; name?: unknown; version?: unknown } | null;
      if (body && body.ok === true && body.name === 'agentdeck') {
        return { state: 'agentdeck', ...(typeof body.version === 'string' ? { version: body.version } : {}) };
      }
      return { state: 'foreign' };
    } catch (err) {
      const code = errorCode(err);
      if (code && CLOSED_CODES.has(code)) return { state: 'closed' };
      if (isTimeout(err)) return { state: 'unresponsive' };
      // Connected, but not HTTP (reset, invalid response, TLS on a plain port …).
      return { state: 'foreign' };
    }
  };
}

/** Polls until `done(probe)` or the deadline; returns the last probe. */
export async function waitForHealth(options: {
  probe: () => Promise<HealthProbe>;
  done: (probe: HealthProbe) => boolean;
  timeoutMs: number;
  intervalMs?: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<{ ok: boolean; probe: HealthProbe }> {
  const deadline = options.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 300;
  for (;;) {
    const probe = await options.probe();
    if (options.done(probe)) return { ok: true, probe };
    if (options.now() >= deadline) return { ok: false, probe };
    await options.sleep(interval);
  }
}
