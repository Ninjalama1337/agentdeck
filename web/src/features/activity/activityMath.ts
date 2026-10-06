/**
 * Numbers behind the Activity sheet: day buckets in the device's timezone,
 * axis ticks and compact figures. Pure — the sheet only draws.
 */
import type { StatsBucket } from '@agentdeck/shared';

export type Metric = 'runs' | 'tokens' | 'cost' | 'time';

export const METRIC_LABELS: Record<Metric, string> = {
  runs: 'Runs',
  tokens: 'Tokens',
  cost: 'Cost',
  time: 'Time',
};

const DAY_MS = 24 * 60 * 60_000;

/** The bucket's value for a metric. Tokens: what was sent and written, without cache reads. */
export function metricOf(bucket: StatsBucket, metric: Metric): number {
  if (metric === 'runs') return bucket.runs;
  if (metric === 'tokens') return bucket.inputTokens + bucket.outputTokens + bucket.cacheWriteTokens;
  if (metric === 'cost') return bucket.costUsd;
  return bucket.durationMs;
}

/** 1284 → "1,284" · 12940 → "12.9K" · 4200000 → "4.2M" */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString('en-US');
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const value = n / size;
      return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}${unit}`;
    }
  }
  return String(Math.round(n));
}

/** "42s" · "3m" · "1h 05m" · "2d 4h" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatMetric(value: number, metric: Metric): string {
  if (metric === 'cost') return money(value);
  if (metric === 'time') return duration(value);
  return compact(value);
}

/** Local calendar day of an instant as `YYYY-MM-DD` — the key the server groups by. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every local day from `from` to `to`, oldest first, at most `max` (the newest ones). */
export function dayKeys(from: number, to: number, max = 90): string[] {
  const keys: string[] = [];
  const cursor = new Date(to);
  cursor.setHours(12, 0, 0, 0);
  const first = dayKey(from);
  for (let i = 0; i < max; i++) {
    const key = dayKey(cursor.getTime());
    keys.unshift(key);
    if (key <= first) break;
    // Noon minus a day stays on the previous date across DST changes.
    cursor.setTime(cursor.getTime() - DAY_MS);
  }
  return keys;
}

/** "Mon, Oct 5" for a `YYYY-MM-DD` key. */
export function dayLabel(key: string, withWeekday = true): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  return date.toLocaleDateString('en-US', { ...(withWeekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' });
}

/** A round axis maximum at or above `max` (1 · 2 · 2.5 · 5 × 10ⁿ), at least 1 for counts. */
export function niceMax(max: number, wholeNumbers: boolean): number {
  if (max <= 0) return wholeNumbers ? 1 : 0.01;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= max && (!wholeNumbers || Number.isInteger(candidate))) return candidate;
  }
  return 10 * magnitude;
}

/** Axis maximum for durations: whole minutes or hours rather than powers of ten of milliseconds. */
export function niceDurationMax(maxMs: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map((m) => m * 60_000);
  return steps.find((s) => s >= maxMs) ?? Math.ceil(maxMs / (24 * 3_600_000)) * 24 * 3_600_000;
}
