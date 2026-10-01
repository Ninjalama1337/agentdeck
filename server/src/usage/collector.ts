/**
 * Subscription usage collector for GET /api/usage → AgentUsage[].
 *
 * - claude: `claude -p "/usage"` for session/week limits and request stats.
 * - antigravity: `agy -p /usage` for subscription limits and model quotas.
 * - opencode: `opencode stats` for total cost, tokens, sessions and messages.
 * - codex: local app-server `account/rateLimits/read`, with login fallback.
 * - zcode: plan data and local usage statistics.
 *
 * Results are cached for 30s with in-flight dedupe (concurrent calls share
 * one run). The spawn function is injectable for tests.
 */
import { spawn as spawnProcess } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import type { AgentId, AgentUsage, UsageWindow } from '@agentdeck/shared';
import type { AgentService } from '../agents/registry.js';
import { getZcodePlanInfo, readZcodeSqliteStats } from '../agents/zcode.js';

export const USAGE_TTL_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 30_000;
const AGY_TIMEOUT_MS = 20_000;
const OPENCODE_TIMEOUT_MS = 15_000;
const CODEX_TIMEOUT_MS = 15_000;
const CODEX_APP_SERVER_TIMEOUT_MS = 12_000;
const RAW_CAP = 4000;

/** Exec result shape used by the collector (satisfied by execa with reject:false). */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export type UsageSpawn = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string },
) => Promise<SpawnResult>;

const defaultSpawn: UsageSpawn = (command, args, opts) =>
  execa(command, args, {
    timeout: opts.timeoutMs,
    cwd: opts.cwd,
    reject: false,
    stdin: 'ignore',
  });

export interface CollectorOptions {
  agents: Pick<AgentService, 'infoOf'>;
  /** Spawn function override (tests). */
  spawn?: UsageSpawn;
  /** Availability override (tests); defaults to AgentService detection. */
  isAvailable?: (agentId: AgentId) => boolean;
  /** Codex app-server RPC override; omitted in custom-spawn collectors. */
  readCodexRateLimits?: () => Promise<unknown>;
  ttlMs?: number;
  /** Optional ZCode collector override (tests). */
  zcodeCollector?: () => Promise<Partial<AgentUsage>>;
}

interface CacheEntry {
  at: number;
  result: AgentUsage[];
}

/** Trims + caps raw CLI output kept for transparency. */
function capRaw(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length > RAW_CAP ? trimmed.slice(0, RAW_CAP) : trimmed;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatResetIso(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Claude `/usage` parsing
// ---------------------------------------------------------------------------

export interface ClaudeUsageParse {
  available: boolean;
  reason?: string;
  plan?: string;
  session?: UsageWindow;
  week?: UsageWindow;
  last24h?: UsageWindow;
  last7d?: UsageWindow;
}

/** `resets <anything up to end-of-line or opening parenthesis>` — locale-tolerant. */
const RESETS = /\bresets\s+([^(\n]+)/;

function pctWindow(line: RegExpExecArray | null): UsageWindow | undefined {
  if (!line) return undefined;
  const win: UsageWindow = { pct: Number(line[1]) };
  const resets = RESETS.exec(line[0]);
  if (resets) {
    win.resetsAt = resets[1].trim().replace(
      /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])m\b/gi,
      (_match, hour: string, minute: string | undefined, period: string) => {
        const hour24 = (Number(hour) % 12) + (period.toLowerCase() === 'p' ? 12 : 0);
        return `${String(hour24).padStart(2, '0')}${minute === undefined ? '' : `:${minute}`}`;
      },
    );
  }
  return win;
}

export function parseClaudeUsage(stdout: string): ClaudeUsageParse {
  const session = pctWindow(/Current session:\s*(\d+)%\s*used[^\n]*/.exec(stdout));
  const week = pctWindow(/Current week \(all models\):\s*(\d+)%\s*used[^\n]*/.exec(stdout));
  const l24 = /Last 24h\s*·\s*(\d+)\s+requests?\s*·\s*(\d+)\s+sessions?/.exec(stdout);
  const l7 = /Last 7d\s*·\s*(\d+)\s+requests?\s*·\s*(\d+)\s+sessions?/.exec(stdout);

  if (!session && !week && !l24 && !l7) {
    return { available: false, reason: 'Could not read usage (unexpected CLI output)' };
  }

  const plan = /subscription/i.test(stdout) ? 'Claude subscription' : undefined;
  return {
    available: true,
    ...(plan ? { plan } : {}),
    ...(session ? { session } : {}),
    ...(week ? { week } : {}),
    ...(l24 ? { last24h: { requests: Number(l24[1]), sessions: Number(l24[2]) } } : {}),
    ...(l7 ? { last7d: { requests: Number(l7[1]), sessions: Number(l7[2]) } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Antigravity (AGY) `/usage` parsing
// ---------------------------------------------------------------------------

export interface AntigravityUsageParse {
  available: boolean;
  reason?: string;
  plan?: string;
  session?: UsageWindow;
  week?: UsageWindow;
  modelsQuota?: { name: string; sessionLimit?: UsageWindow; weeklyLimit?: UsageWindow }[];
}

export function parseAntigravityUsage(stdout: string): AntigravityUsageParse {
  if (!/quota|limit remaining/i.test(stdout)) {
    return { available: false, reason: 'Could not read Antigravity quota (unexpected CLI output)' };
  }

  // Gemini models: Five Hour Limit Remaining 68% 2026-09-30T21:45:18Z
  const gemini5h = /Gemini Models\s+Five Hour Limit Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);
  const geminiWeek = /Gemini Models\s+Weekly Limit Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);

  // Fallback pattern if prefix is absent
  const any5h = gemini5h ?? /(?:Five\s+Hour|5\s*Hour|Session)\s+Limit\s+Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);
  const anyWeek = geminiWeek ?? /(?:Weekly|Week)\s+Limit\s+Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);

  const sessionPct = any5h ? Math.max(0, Math.min(100, 100 - Number(any5h[1]))) : undefined;
  const weekPct = anyWeek ? Math.max(0, Math.min(100, 100 - Number(anyWeek[1]))) : undefined;

  const session: UsageWindow | undefined =
    sessionPct !== undefined
      ? { pct: sessionPct, ...(any5h?.[2] ? { resetsAt: formatResetIso(any5h[2]) } : {}) }
      : undefined;

  const week: UsageWindow | undefined =
    weekPct !== undefined
      ? { pct: weekPct, ...(anyWeek?.[2] ? { resetsAt: formatResetIso(anyWeek[2]) } : {}) }
      : undefined;

  const modelsQuota: { name: string; sessionLimit?: UsageWindow; weeklyLimit?: UsageWindow }[] = [];
  if (gemini5h || geminiWeek) {
    modelsQuota.push({
      name: 'Gemini Models',
      ...(session ? { sessionLimit: session } : {}),
      ...(week ? { weeklyLimit: week } : {}),
    });
  }

  const claude5h = /Claude and GPT models\s+Five Hour Limit Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);
  const claudeWeek = /Claude and GPT models\s+Weekly Limit Remaining\s+(\d+)%\s*(\S*)/i.exec(stdout);
  if (claude5h || claudeWeek) {
    const cSessionPct = claude5h ? Math.max(0, Math.min(100, 100 - Number(claude5h[1]))) : undefined;
    const cWeekPct = claudeWeek ? Math.max(0, Math.min(100, 100 - Number(claudeWeek[1]))) : undefined;
    modelsQuota.push({
      name: 'Claude & GPT Models',
      ...(cSessionPct !== undefined
        ? { sessionLimit: { pct: cSessionPct, ...(claude5h?.[2] ? { resetsAt: formatResetIso(claude5h[2]) } : {}) } }
        : {}),
      ...(cWeekPct !== undefined
        ? { weeklyLimit: { pct: cWeekPct, ...(claudeWeek?.[2] ? { resetsAt: formatResetIso(claudeWeek[2]) } : {}) } }
        : {}),
    });
  }

  return {
    available: true,
    plan: 'Gemini & Claude/GPT Quota',
    ...(session ? { session } : {}),
    ...(week ? { week } : {}),
    ...(modelsQuota.length > 0 ? { modelsQuota } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenCode stats parsing
// ---------------------------------------------------------------------------

export interface OpenCodeUsageParse {
  available: boolean;
  reason?: string;
  plan?: string;
  cost?: string;
  tokens?: { input?: string; output?: string; cache?: string };
  session?: UsageWindow;
  last24h?: UsageWindow;
}

export function parseOpenCodeUsage(stdout: string): OpenCodeUsageParse {
  if (!/overview|cost & tokens|total cost/i.test(stdout)) {
    return { available: false, reason: 'Could not read OpenCode stats (unexpected CLI output)' };
  }

  const costMatch = /Total Cost\s+\$([0-9.]+)/i.exec(stdout);
  const cost = costMatch ? `$${costMatch[1]}` : undefined;

  const sessionsMatch = /Sessions\s+([0-9,]+)/i.exec(stdout);
  const sessions = sessionsMatch ? Number(sessionsMatch[1].replace(/,/g, '')) : undefined;

  const messagesMatch = /Messages\s+([0-9,]+)/i.exec(stdout);
  const messages = messagesMatch ? Number(messagesMatch[1].replace(/,/g, '')) : undefined;

  const inputMatch = /Input\s+([0-9.]+[kMGT]?)/i.exec(stdout);
  const outputMatch = /Output\s+([0-9.]+[kMGT]?)/i.exec(stdout);
  const cacheMatch = /Cache Read\s+([0-9.]+[kMGT]?)/i.exec(stdout);

  const tokens = {
    ...(inputMatch ? { input: inputMatch[1] } : {}),
    ...(outputMatch ? { output: outputMatch[1] } : {}),
    ...(cacheMatch ? { cache: cacheMatch[1] } : {}),
  };

  const plan = cost ? `${cost} spent · Pay-as-you-go` : 'OpenCode Pay-as-you-go';

  return {
    available: true,
    plan,
    ...(cost ? { cost } : {}),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
    session: {
      requests: messages,
      sessions,
    },
    last24h: {
      requests: messages,
      sessions,
    },
  };
}

// ---------------------------------------------------------------------------
// Codex app-server rate limits
// ---------------------------------------------------------------------------

export interface CodexUsageParse {
  available: boolean;
  reason?: string;
  plan?: string;
  rateLimits?: { name: string; window: UsageWindow }[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexWindowName(durationMins: number | undefined, slot: string): string {
  if (durationMins === 300) return '5-hour limit';
  if (durationMins === 10_080) return 'Weekly limit';
  if (durationMins !== undefined && durationMins % 1440 === 0) {
    return `${durationMins / 1440}-day limit`;
  }
  if (durationMins !== undefined && durationMins % 60 === 0) {
    return `${durationMins / 60}-hour limit`;
  }
  return durationMins !== undefined ? `${durationMins}-minute limit` : `${slot} limit`;
}

function codexResetIso(value: unknown): string | undefined {
  let timestamp: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  } else if (typeof value === 'string') {
    if (/^\d{10,13}$/.test(value)) {
      const numeric = Number(value);
      timestamp = value.length === 13 ? numeric : numeric * 1000;
    } else {
      timestamp = Date.parse(value);
    }
  } else {
    return undefined;
  }
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

/** Parses `account/rateLimits/read`, omitting account identifiers and credits. */
export function parseCodexRateLimits(payload: unknown): CodexUsageParse {
  const root = asRecord(payload);
  const byLimitId = asRecord(root?.rateLimitsByLimitId);
  const aggregateLimits = asRecord(root?.rateLimits);
  const codexLimits = asRecord(byLimitId?.codex);
  const limits = aggregateLimits || codexLimits ? { ...aggregateLimits, ...codexLimits } : undefined;
  if (!limits) return { available: false, reason: 'Codex rate limits are unavailable' };

  const rateLimits: { name: string; window: UsageWindow }[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const source = asRecord(limits[slot]);
    if (!source || typeof source.usedPercent !== 'number' || !Number.isFinite(source.usedPercent)) continue;
    const duration =
      typeof source.windowDurationMins === 'number' && Number.isFinite(source.windowDurationMins)
        ? source.windowDurationMins
        : undefined;
    const resetsAt = codexResetIso(source.resetsAt);
    const window: UsageWindow = {
      pct: Math.round(Math.max(0, Math.min(100, source.usedPercent))),
      ...(resetsAt ? { resetsAt } : {}),
    };
    rateLimits.push({ name: codexWindowName(duration, slot), window });
  }

  if (rateLimits.length === 0) {
    return { available: false, reason: 'Codex returned no active rate-limit windows' };
  }

  const planType = typeof limits.planType === 'string' ? limits.planType.trim() : '';
  const plan = planType
    ? `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`
    : undefined;
  return { available: true, ...(plan ? { plan } : {}), rateLimits };
}

/** Reads rate limits through Codex's local app-server protocol; no auth file is read by AgentDeck. */
function readCodexRateLimitsFromAppServer(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('codex', ['app-server', '--stdio'], {
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) {
      child.kill('SIGTERM');
      reject(new Error('Codex app-server did not open its stdio transport'));
      return;
    }
    const lines = createInterface({ input: stdout });
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error('Codex app-server rate-limit request timed out')),
      CODEX_APP_SERVER_TIMEOUT_MS,
    );
    stdin.on('error', () => undefined);
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.id === 1) {
        const error = asRecord(message.error);
        if (error) {
          finish(new Error(typeof error.message === 'string' ? error.message : 'Codex app-server initialization failed'));
          return;
        }
        try {
          stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`,
          );
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      } else if (message.id === 2) {
        const error = asRecord(message.error);
        if (error) {
          finish(new Error(typeof error.message === 'string' ? error.message : 'Codex rate-limit request failed'));
        } else {
          finish(undefined, message.result);
        }
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before returning usage (code ${code ?? 'unknown'})`));
    });
    try {
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.1.0' },
            capabilities: { experimentalApi: true },
          },
        })}\n`,
      );
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------

export class UsageCollector {
  private readonly spawn: UsageSpawn;
  private readonly isAvailableFn: (agentId: AgentId) => boolean;
  private readonly readCodexRateLimits?: () => Promise<unknown>;
  private readonly ttlMs: number;
  private cache?: CacheEntry;
  private inflight?: Promise<AgentUsage[]>;

  private readonly zcodeCollector?: () => Promise<Partial<AgentUsage>>;

  constructor(opts: CollectorOptions) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.isAvailableFn = opts.isAvailable ?? ((id) => opts.agents.infoOf(id)?.available === true);
    this.readCodexRateLimits =
      opts.readCodexRateLimits ?? (opts.spawn ? undefined : readCodexRateLimitsFromAppServer);
    this.ttlMs = opts.ttlMs ?? USAGE_TTL_MS;
    this.zcodeCollector = opts.zcodeCollector;
  }

  /** Clears cached usage snapshots (e.g. after a plan switch). */
  clearCache(): void {
    this.cache = undefined;
  }

  /** Cached per-agent usage snapshot; concurrent calls share one collection run. */
  async collect(now = Date.now()): Promise<AgentUsage[]> {
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.result;
    if (this.inflight) return this.inflight;
    this.inflight = this.collectUncached()
      .then((result) => {
        this.cache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async collectUncached(): Promise<AgentUsage[]> {
    const fetchedAt = Date.now();
    const entries = await Promise.all([
      this.collectClaude(fetchedAt),
      this.collectAntigravity(fetchedAt),
      this.collectOpenCode(fetchedAt),
      this.collectCodex(fetchedAt),
      this.collectZcode(fetchedAt),
    ]);
    return entries;
  }

  private async collectClaude(fetchedAt: number): Promise<AgentUsage> {
    const base: AgentUsage = { agentId: 'claude', available: false, fetchedAt };
    if (!this.isAvailableFn('claude')) {
      return { ...base, reason: 'Claude Code CLI not available' };
    }
    let res: SpawnResult;
    try {
      res = await this.spawn('claude', ['-p', '/usage'], {
        timeoutMs: CLAUDE_TIMEOUT_MS,
        cwd: os.homedir(),
      });
    } catch (err) {
      return { ...base, reason: `claude -p "/usage" failed: ${errorMessage(err)}`, fetchedAt };
    }
    const raw = capRaw(res.stdout || res.stderr);
    const parsed = parseClaudeUsage(res.stdout);
    if (!parsed.available) {
      return { ...base, reason: parsed.reason, ...(raw ? { raw } : {}), fetchedAt };
    }
    return {
      agentId: 'claude',
      available: true,
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.week ? { week: parsed.week } : {}),
      ...(parsed.last24h ? { last24h: parsed.last24h } : {}),
      ...(parsed.last7d ? { last7d: parsed.last7d } : {}),
      ...(raw ? { raw } : {}),
      fetchedAt,
    };
  }

  private async collectAntigravity(fetchedAt: number): Promise<AgentUsage> {
    const base: AgentUsage = { agentId: 'antigravity', available: false, fetchedAt };
    if (!this.isAvailableFn('antigravity')) {
      return { ...base, reason: 'Antigravity (AGY) CLI not available' };
    }
    let res: SpawnResult;
    try {
      res = await this.spawn('agy', ['-p', '/usage'], {
        timeoutMs: AGY_TIMEOUT_MS,
        cwd: os.homedir(),
      });
    } catch {
      // Fallback probe via flatpak if native agy failed
      try {
        res = await this.spawn('flatpak', ['run', '--command=agy', 'com.google.Antigravity', '-p', '/usage'], {
          timeoutMs: AGY_TIMEOUT_MS,
          cwd: os.homedir(),
        });
      } catch (err) {
        return { ...base, reason: `agy -p "/usage" failed: ${errorMessage(err)}`, fetchedAt };
      }
    }

    const raw = capRaw(res.stdout || res.stderr);
    const parsed = parseAntigravityUsage(res.stdout);
    if (!parsed.available) {
      return { ...base, reason: parsed.reason, ...(raw ? { raw } : {}), fetchedAt };
    }
    return {
      agentId: 'antigravity',
      available: true,
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.week ? { week: parsed.week } : {}),
      ...(parsed.modelsQuota ? { modelsQuota: parsed.modelsQuota } : {}),
      ...(raw ? { raw } : {}),
      fetchedAt,
    };
  }

  private async collectOpenCode(fetchedAt: number): Promise<AgentUsage> {
    const base: AgentUsage = { agentId: 'opencode', available: false, fetchedAt };
    if (!this.isAvailableFn('opencode')) {
      return { ...base, reason: 'OpenCode CLI not available' };
    }
    let res: SpawnResult;
    try {
      res = await this.spawn('opencode', ['stats'], {
        timeoutMs: OPENCODE_TIMEOUT_MS,
        cwd: os.homedir(),
      });
    } catch (err) {
      return { ...base, reason: `opencode stats failed: ${errorMessage(err)}`, fetchedAt };
    }
    const raw = capRaw(res.stdout || res.stderr);
    const parsed = parseOpenCodeUsage(res.stdout);
    if (!parsed.available) {
      return { ...base, reason: parsed.reason, ...(raw ? { raw } : {}), fetchedAt };
    }
    return {
      agentId: 'opencode',
      available: true,
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      ...(parsed.cost ? { cost: parsed.cost } : {}),
      ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.last24h ? { last24h: parsed.last24h } : {}),
      ...(raw ? { raw } : {}),
      fetchedAt,
    };
  }

  private async collectCodex(fetchedAt: number): Promise<AgentUsage> {
    const base: AgentUsage = { agentId: 'codex', available: false, fetchedAt };
    if (!this.isAvailableFn('codex')) {
      return { ...base, reason: 'Codex CLI not available' };
    }
    let res: SpawnResult;
    try {
      res = await this.spawn('codex', ['login', 'status'], {
        timeoutMs: CODEX_TIMEOUT_MS,
        cwd: os.homedir(),
      });
    } catch (err) {
      return { ...base, reason: `codex login status failed: ${errorMessage(err)}`, fetchedAt };
    }
    const raw = capRaw(res.stdout || res.stderr);
    const combined = `${res.stdout}\n${res.stderr}`;
    const first = firstLine(res.stdout) || firstLine(res.stderr);
    if (/logged in/i.test(combined)) {
      let rateLimitError: string | undefined;
      if (this.readCodexRateLimits) {
        try {
          const parsed = parseCodexRateLimits(await this.readCodexRateLimits());
          if (parsed.available) {
            return {
              agentId: 'codex',
              available: true,
              ...(parsed.plan ? { plan: parsed.plan } : first ? { plan: first } : {}),
              ...(parsed.rateLimits ? { rateLimits: parsed.rateLimits } : {}),
              fetchedAt,
            };
          }
          rateLimitError = parsed.reason;
        } catch (err) {
          rateLimitError = errorMessage(err);
        }
      }
      return {
        agentId: 'codex',
        available: true,
        ...(first ? { plan: first } : {}),
        reason: rateLimitError
          ? `Could not read Codex rate limits — login status only: ${rateLimitError}`
          : 'Could not read Codex rate limits — login status only',
        ...(raw ? { raw } : {}),
        fetchedAt,
      };
    }
    return {
      ...base,
      reason: first || 'codex is not logged in',
      ...(raw ? { raw } : {}),
      fetchedAt,
    };
  }

  private async collectZcode(fetchedAt: number): Promise<AgentUsage> {
    const base: AgentUsage = { agentId: 'zcode', available: false, fetchedAt };
    if (!this.isAvailableFn('zcode')) {
      return { ...base, reason: 'ZCode CLI not available' };
    }
    if (this.zcodeCollector) {
      const custom = await this.zcodeCollector();
      return { ...base, available: true, ...custom, agentId: 'zcode', fetchedAt };
    }
    try {
      const [plansInfo, stats] = await Promise.all([
        getZcodePlanInfo(),
        readZcodeSqliteStats(),
      ]);
      return {
        agentId: 'zcode',
        available: true,
        plan: plansInfo.activePlanLabel,
        activePlanId: plansInfo.activePlanId,
        plans: plansInfo.plans,
        session: plansInfo.session,
        week: plansInfo.week,
        last24h: stats.last24h,
        last7d: stats.last7d,
        raw: plansInfo.raw,
        fetchedAt,
      };
    } catch (err) {
      return { ...base, reason: `ZCode usage collection failed: ${errorMessage(err)}` };
    }
  }

}
