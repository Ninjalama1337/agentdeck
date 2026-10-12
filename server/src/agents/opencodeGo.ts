/**
 * OpenCode Go subscription usage.
 *
 * OpenCode Go (opencode.ai/go) is a monthly subscription whose quota is split
 * into rolling 5-hour, weekly and monthly windows. Unlike `opencode stats`
 * (local telemetry only), the official endpoint
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <api key>
 *
 * returns the account-wide used percentages. The key is the one `opencode auth`
 * stores in ~/.local/share/opencode/auth.json — the `opencode-go` entry, with
 * the plain `opencode` (Zen) entry as a fallback. A key without an active Go
 * plan is answered with 401, which we surface as "no subscription".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageWindow } from '@agentdeck/shared';

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_GO_TIMEOUT_MS = 8_000;

export interface OpenCodeGoUsage {
  available: boolean;
  reason?: string;
  plan?: string;
  /** Rolling 5-hour window. */
  session?: UsageWindow;
  /** Weekly window. */
  week?: UsageWindow;
  /** Monthly window. */
  monthly?: UsageWindow;
}

/** Path of the auth store `opencode auth` writes to (XDG-aware). */
export function opencodeAuthFile(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

/** API key for the Go plan from the OpenCode auth store (`opencode-go` wins). */
export function readOpenCodeGoApiKey(authFile = opencodeAuthFile()): string | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    for (const id of ['opencode-go', 'opencode']) {
      const entry = json[id];
      if (entry && typeof entry === 'object') {
        const key = (entry as Record<string, unknown>).key;
        if (typeof key === 'string' && key) return key;
      }
    }
  } catch {
    /* no auth store on this machine */
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One `{ status, percent, resetsAt }` window; `percent` is used, not remaining. */
function parseWindow(value: unknown): UsageWindow | undefined {
  const w = asRecord(value);
  if (!w) return undefined;
  const status = typeof w.status === 'string' ? w.status : undefined;
  const pct =
    typeof w.percent === 'number' && Number.isFinite(w.percent)
      ? Math.round(Math.max(0, Math.min(100, w.percent)))
      : undefined;
  const resetsAt = typeof w.resetsAt === 'string' && w.resetsAt ? w.resetsAt : undefined;
  if (status && status !== 'ok' && pct === undefined) return undefined;
  if (pct === undefined && !resetsAt) return undefined;
  return { ...(pct !== undefined ? { pct } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

/** Parses `GET /zen/go/v1/usage` — `{ usage: { rolling, weekly, monthly } }`. */
export function parseOpenCodeGoUsage(payload: unknown): OpenCodeGoUsage {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage) ?? root;
  if (!usage) return { available: false, reason: 'OpenCode Go returned no usage windows' };

  const session = parseWindow(usage.rolling);
  const week = parseWindow(usage.weekly);
  const monthly = parseWindow(usage.monthly);
  if (!session && !week && !monthly) {
    return { available: false, reason: 'OpenCode Go returned no active usage windows' };
  }

  return {
    available: true,
    plan: 'OpenCode Go subscription',
    ...(session ? { session } : {}),
    ...(week ? { week } : {}),
    ...(monthly ? { monthly } : {}),
  };
}

/** Fetches the Go quota for `apiKey`; never throws (offline / no plan → unavailable). */
export async function fetchOpenCodeGoUsage(
  apiKey: string,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<OpenCodeGoUsage> {
  try {
    const res = await fetch(opts.url ?? OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? OPENCODE_GO_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'No active OpenCode Go subscription for this key' };
    }
    if (!res.ok) {
      return { available: false, reason: `OpenCode Go usage request failed (HTTP ${res.status})` };
    }
    return parseOpenCodeGoUsage(await res.json());
  } catch (err) {
    return {
      available: false,
      reason: `OpenCode Go usage request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Reads the key from disk and fetches the Go quota, or reports why it could not. */
export async function collectOpenCodeGoUsage(authFile = opencodeAuthFile()): Promise<OpenCodeGoUsage> {
  const key = readOpenCodeGoApiKey(authFile);
  if (!key) return { available: false, reason: 'No OpenCode API key found (run `opencode auth`)' };
  return fetchOpenCodeGoUsage(key);
}
