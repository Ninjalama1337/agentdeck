/**
 * Usage watcher: reads the subscription limits in the background while agents
 * are in use and pushes a `usage-limit` notification when a window crosses
 * 80, 95 or 100 % — before an agent stalls on it (after Orca's limit warning).
 *
 * Each window warns once per level and reset period: a new `resetsAt` (the
 * window rolled over) or a drop below the level re-arms it.
 */
import type { AgentId, AgentUsage, UsageWindow } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';

export const USAGE_LEVELS = [80, 95, 100] as const;
export const USAGE_WATCH_INTERVAL_MS = 15 * 60 * 1000;

interface Seen {
  level: number;
  resetsAt?: string;
}

export interface LimitAlert {
  agentId: AgentId;
  window: string;
  pct: number;
  level: number;
  resetsAt?: string;
}

function windowsOf(u: AgentUsage): { key: string; name: string; win: UsageWindow }[] {
  const out: { key: string; name: string; win: UsageWindow }[] = [];
  if (u.session) out.push({ key: 'session', name: '5-hour limit', win: u.session });
  if (u.week) out.push({ key: 'week', name: 'weekly limit', win: u.week });
  for (const r of u.rateLimits ?? []) out.push({ key: `rl:${r.name}`, name: r.name, win: r.window });
  return out;
}

/** Alerts for windows that reached a higher level than last time; updates `seen`. */
export function limitCrossings(seen: Map<string, Seen>, usages: AgentUsage[]): LimitAlert[] {
  const alerts: LimitAlert[] = [];
  for (const u of usages) {
    for (const { key, name, win } of windowsOf(u)) {
      if (typeof win.pct !== 'number') continue;
      const id = `${u.agentId}:${key}`;
      const level = [...USAGE_LEVELS].reverse().find((l) => win.pct! >= l) ?? 0;
      const prev = seen.get(id);
      const rolled = prev !== undefined && prev.resetsAt !== win.resetsAt;
      const before = prev && !rolled ? prev.level : 0;
      if (level > before) {
        alerts.push({ agentId: u.agentId, window: name, pct: Math.round(win.pct), level, ...(win.resetsAt ? { resetsAt: win.resetsAt } : {}) });
      }
      // Remember the level actually reached — dropping below re-arms the warning.
      seen.set(id, { level, ...(win.resetsAt ? { resetsAt: win.resetsAt } : {}) });
    }
  }
  return alerts;
}

/** "Claude: weekly limit at 96 %" + "Resets in 2 h 13 min." */
export function alertText(a: LimitAlert, now = Date.now()): { title: string; body: string } {
  const who = AGENT_LABELS[a.agentId] ?? a.agentId;
  const title = a.level >= 100 ? `${who}: ${a.window} used up` : `${who}: ${a.window} at ${a.pct}%`;
  let body =
    a.level >= 100
      ? 'Agents on this plan stop until it resets — hand the task over from the terminal, or switch the account.'
      : 'Consider pacing or switching agents.';
  const at = a.resetsAt && /^\d{4}-\d{2}-\d{2}T/.test(a.resetsAt) ? Date.parse(a.resetsAt) : NaN;
  if (!Number.isNaN(at) && at > now) {
    const minutes = Math.ceil((at - now) / 60_000);
    const hours = Math.floor(minutes / 60);
    const left = hours >= 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
    body = `Resets in ${left}. ${body}`;
  }
  return { title, body };
}

export interface UsageWatcherOptions {
  collect(): Promise<AgentUsage[]>;
  /** Readings go on record like those the app asks for. */
  record?(usages: AgentUsage[]): void;
  /** Only poll while agents are in use — reading limits spawns the CLIs. */
  active(): boolean;
  notify(alert: LimitAlert): void;
  intervalMs?: number;
  onError?(err: unknown): void;
}

export class UsageWatcher {
  private readonly seen = new Map<string, Seen>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: UsageWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? USAGE_WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reading (exposed for tests and for the app's own usage fetches). */
  async tick(): Promise<void> {
    if (this.running || !this.opts.active()) return;
    this.running = true;
    try {
      this.observe(await this.opts.collect());
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
  }

  /** Readings from anywhere (also GET /api/usage) feed the same thresholds. */
  observe(usages: AgentUsage[]): void {
    this.opts.record?.(usages);
    for (const alert of limitCrossings(this.seen, usages)) this.opts.notify(alert);
  }
}
