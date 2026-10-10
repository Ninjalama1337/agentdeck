import type { Activity } from './closeDecision';
import type { FetchLike } from './health';

interface SessionLike {
  status?: unknown;
}

/**
 * Running agent runs and open terminals, for the close dialog. Null when the
 * server cannot be asked (no token, not reachable, unexpected answer) — the
 * dialog then simply leaves the numbers out.
 */
export async function fetchActivity(options: {
  baseUrl: string;
  token: string | null;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<Activity | null> {
  if (!options.token) return null;
  const headers = { authorization: `Bearer ${options.token}` };
  const timeout = options.timeoutMs ?? 2000;
  async function list(route: string): Promise<unknown[] | null> {
    try {
      const res = await options.fetch(`${options.baseUrl}/api/${route}`, { headers, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  const [sessions, terminals] = await Promise.all([list('sessions'), list('terminals')]);
  if (!sessions || !terminals) return null;
  const runs = sessions.filter((s) => {
    const status = (s as SessionLike | null)?.status;
    return status === 'running' || status === 'queued';
  }).length;
  return { runs, terminals: terminals.length };
}
