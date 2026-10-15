/**
 * Usage limits as one list of windows per agent — the shape the usage
 * button, the compact roster and the warnings read (after Orca's status bar):
 * the 5-hour and weekly windows side by side, a live countdown to each reset,
 * agents ordered by their tightest limit, and "% used" or "% left" on request.
 */
import type { AgentId, AgentUsage, UsageWindow } from '@agentdeck/shared';

export type UsageDisplay = 'used' | 'left';

/** Share of a limit at which it reads as tight (red). */
export const USAGE_WARN_PCT = 80;

export interface LimitWindow {
  key: string;
  /** Full name ("Session limit", "Weekly limit", a Codex window name). */
  label: string;
  /** Chip label ("5h", "wk"). */
  short: string;
  /** Used, 0..100. */
  pct: number;
  resetsAt?: string;
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Short chip label for a provider window name ("5h limit" → "5h", "Weekly" → "wk"). */
export function shortWindowLabel(name: string): string {
  const n = name.toLowerCase();
  if (/week|7.?d/.test(n)) return 'wk';
  if (/month|30.?d/.test(n)) return 'mo';
  if (/day|24.?h/.test(n)) return 'day';
  const hours = /(\d+)\s*-?\s*h/.exec(n);
  if (hours) return `${hours[1]}h`;
  if (/session|primary/.test(n)) return '5h';
  return name.length > 6 ? name.slice(0, 6) : name;
}

/** Every limit window with a known percentage, session before week before the rest. */
export function limitWindows(usage: AgentUsage | undefined): LimitWindow[] {
  if (!usage) return [];
  const out: LimitWindow[] = [];
  const push = (key: string, label: string, short: string, win: UsageWindow | undefined): void => {
    if (typeof win?.pct !== 'number') return;
    out.push({ key, label, short, pct: clamp(win.pct), ...(win.resetsAt ? { resetsAt: win.resetsAt } : {}) });
  };
  push('session', 'Session limit', '5h', usage.session);
  push('week', 'Weekly limit', 'wk', usage.week);
  for (const limit of usage.rateLimits ?? []) push(`rl:${limit.name}`, limit.name, shortWindowLabel(limit.name), limit.window);
  return out;
}

/** The fullest window (null when no window has a number). */
export function tightestWindow(usage: AgentUsage | undefined): LimitWindow | null {
  return limitWindows(usage).reduce<LimitWindow | null>((best, w) => (best === null || w.pct > best.pct ? w : best), null);
}

/**
 * Tightest limit first; agents without numbers after those with, unavailable
 * ones last. Equal pressure keeps the given order.
 */
export function sortByTightest(list: AgentUsage[]): AgentUsage[] {
  const score = (u: AgentUsage): number => {
    const tight = tightestWindow(u);
    if (tight) return tight.pct;
    return u.available ? -1 : -2;
  };
  return list
    .map((u, i) => ({ u, i, s: score(u) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ u }) => u);
}

/** Number to show for a used percentage. */
export function shownPct(used: number, display: UsageDisplay): number {
  return display === 'left' ? 100 - clamp(used) : clamp(used);
}

export function pctLabel(used: number, display: UsageDisplay): string {
  return `${shownPct(used, display)}% ${display === 'left' ? 'left' : 'used'}`;
}

/**
 * Time until `resetsAt` ("45m", "2h 13m", "3d 4h"); null when it is not a
 * timestamp. A reset in the past reads "now" — the next fetch brings the new window.
 */
export function countdown(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt || !/^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface UsageWarning {
  agentId: AgentId;
  window: LimitWindow;
}

/** Windows at or past the warning line, fullest first. */
export function usageWarnings(list: AgentUsage[] | null | undefined): UsageWarning[] {
  const out: UsageWarning[] = [];
  for (const u of list ?? []) {
    for (const w of limitWindows(u)) if (w.pct >= USAGE_WARN_PCT) out.push({ agentId: u.agentId, window: w });
  }
  return out.sort((a, b) => b.window.pct - a.window.pct);
}
