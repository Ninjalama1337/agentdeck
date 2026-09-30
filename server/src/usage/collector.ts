/**
 * Subscription usage collector for GET /api/usage → AgentUsage[].
 *
 * - claude: spawns `claude -p "/usage"` (cwd = home dir, 30s cap) and parses
 *   the plan-usage output (tolerant of locale dates / trailing detail).
 * - codex: `codex login status` (15s cap) — login status only, no numbers.
 * - zcode / antigravity: IDE agents, no usage API.
 *
 * Results are cached for 60s with in-flight dedupe (concurrent calls share
 * one run). The spawn function is injectable for tests.
 */
import os from 'node:os';
import { execa } from 'execa';
import type { AgentId, AgentUsage, UsageWindow } from '@agentdeck/shared';
import type { AgentService } from '../agents/registry.js';

export const USAGE_TTL_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 30_000;
const CODEX_TIMEOUT_MS = 15_000;
const RAW_CAP = 4000;

/** Exec result shape used by the collector (satisfied by execa with reject:false). */
export interface SpawnResult {
  stdout: string;
  stderr: string;
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
  ttlMs?: number;
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

// ---------------------------------------------------------------------------
// Claude `/usage` parsing (English + locale dates, tolerant of trailing text)
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
  if (resets) win.resetsAt = resets[1].trim();
  return win;
}

/**
 * Parses the recorded `claude -p "/usage"` output. Returns available:false with
 * a stable reason when none of the percentage/request markers are present
 * (e.g. the CLI answered with an assistant message instead of plan usage).
 */
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

export class UsageCollector {
  private readonly spawn: UsageSpawn;
  private readonly isAvailableFn: (agentId: AgentId) => boolean;
  private readonly ttlMs: number;
  private cache?: CacheEntry;
  private inflight?: Promise<AgentUsage[]>;

  constructor(opts: CollectorOptions) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.isAvailableFn = opts.isAvailable ?? ((id) => opts.agents.infoOf(id)?.available === true);
    this.ttlMs = opts.ttlMs ?? USAGE_TTL_MS;
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
      this.collectCodex(fetchedAt),
      Promise.resolve(this.ideEntry('zcode', fetchedAt)),
      Promise.resolve(this.ideEntry('antigravity', fetchedAt)),
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
      return {
        agentId: 'codex',
        available: true,
        ...(first ? { plan: first } : {}),
        reason: 'Codex exposes no usage statistics via CLI — login status only',
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

  private ideEntry(agentId: AgentId, fetchedAt: number): AgentUsage {
    return { agentId, available: false, reason: 'IDE agent — no usage API exposed', fetchedAt };
  }
}
