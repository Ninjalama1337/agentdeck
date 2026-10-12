import os from 'node:os';

/** Result of one pairing attempt. */
export type PairOutcome =
  | { ok: true; token: string; serverName: string }
  | { ok: false; reason: string };

/** `<hostname> (Desktop)`, kept within the server's 64 character limit. */
export function deviceName(hostname: string = os.hostname()): string {
  const suffix = ' (Desktop)';
  const host = hostname.trim() || 'Linux';
  return `${host.slice(0, 64 - suffix.length)}${suffix}`;
}

/** A pairing code as the server writes it: exactly six digits. */
export function parsePairingCode(text: string): string | null {
  const code = text.trim();
  return /^\d{6}$/.test(code) ? code : null;
}

interface PairResponseBody {
  token?: unknown;
  server?: { name?: unknown } | null;
  pending?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

export interface PairDeps {
  baseUrl: string;
  codeFile: string;
  name: string;
  readFile(file: string): Promise<string>;
  fetch(
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<{ status: number; json(): Promise<unknown> }>;
  timeoutMs?: number;
}

/**
 * Pairs this device with the local server: reads the current code (it rotates
 * after every use, so always fresh) and trades it for a device token. The
 * server hands tokens out directly to requests from the machine itself.
 */
export async function pairWithLocalServer(deps: PairDeps): Promise<PairOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let code: string | null;
    try {
      code = parsePairingCode(await deps.readFile(deps.codeFile));
    } catch {
      return { ok: false, reason: `Cannot read the pairing code (${deps.codeFile}) — pair this device by hand.` };
    }
    if (!code) return { ok: false, reason: 'The pairing code file is empty — pair this device by hand.' };

    let status: number;
    let body: PairResponseBody | null;
    try {
      const res = await deps.fetch(`${deps.baseUrl}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: deps.name }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      });
      status = res.status;
      body = (await res.json().catch(() => null)) as PairResponseBody | null;
    } catch (err) {
      return { ok: false, reason: `Pairing request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (status === 200 && body && typeof body.token === 'string' && body.token) {
      const name = typeof body.server?.name === 'string' ? body.server.name : '';
      return { ok: true, token: body.token, serverName: name };
    }
    if (status === 202 || body?.pending) {
      return { ok: false, reason: 'The server wants this pairing approved on another device.' };
    }
    // 401: the code rotated between reading and sending (a phone paired meanwhile) — read again once.
    if (status === 401 && attempt === 0) continue;
    const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${status}`;
    return { ok: false, reason: message };
  }
  return { ok: false, reason: 'Pairing failed.' };
}

/**
 * Re-pairing guard: at most `max` successful pairings per `windowMs`, and one
 * at a time. A token the server keeps rejecting must not turn into a login loop.
 */
export function createPairingCoordinator(options: {
  pair: () => Promise<PairOutcome>;
  now: () => number;
  max?: number;
  windowMs?: number;
}): { request(): Promise<PairOutcome>; lastToken(): string | null } {
  const max = options.max ?? 3;
  const windowMs = options.windowMs ?? 5 * 60_000;
  let stamps: number[] = [];
  let inflight: Promise<PairOutcome> | null = null;
  let token: string | null = null;
  return {
    request() {
      if (inflight) return inflight;
      const now = options.now();
      stamps = stamps.filter((t) => now - t < windowMs);
      if (stamps.length >= max) {
        return Promise.resolve({ ok: false, reason: 'Paired too often in a short time — pair this device by hand.' });
      }
      inflight = options
        .pair()
        .then((outcome) => {
          if (outcome.ok) {
            stamps.push(now);
            token = outcome.token;
          }
          return outcome;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    lastToken: () => token,
  };
}
