import { describe, expect, it } from 'vitest';
import type { StatsBucket } from '@agentdeck/shared';
import { compact, dayKey, dayKeys, duration, metricOf, money, niceDurationMax, niceMax } from '../src/features/activity/activityMath';

const bucket: StatsBucket = {
  runs: 3,
  ok: 2,
  errors: 1,
  stopped: 0,
  durationMs: 90_000,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10_000,
  cacheWriteTokens: 25,
  costUsd: 1.5,
  toolCalls: 4,
};

describe('activity figures', () => {
  it('counts tokens without cache reads', () => {
    expect(metricOf(bucket, 'tokens')).toBe(175);
    expect(metricOf(bucket, 'runs')).toBe(3);
    expect(metricOf(bucket, 'cost')).toBe(1.5);
    expect(metricOf(bucket, 'time')).toBe(90_000);
  });

  it('writes numbers compactly', () => {
    expect(compact(1284)).toBe('1,284');
    expect(compact(12_940)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
    expect(compact(250_000)).toBe('250K');
    expect(duration(42_000)).toBe('42s');
    expect(duration(65 * 60_000)).toBe('1h 05m');
    expect(duration(52 * 3_600_000)).toBe('2d 4h');
    expect(money(0)).toBe('$0');
    expect(money(37.114)).toBe('$37.11');
    expect(money(0.0517)).toBe('$0.052');
  });

  it('picks round axis maxima', () => {
    expect(niceMax(17, true)).toBe(20);
    expect(niceMax(3, true)).toBe(5);
    expect(niceMax(0, true)).toBe(1);
    expect(niceMax(0.37, false)).toBe(0.5);
    expect(niceMax(100, true)).toBe(100);
    expect(niceDurationMax(7 * 60_000)).toBe(10 * 60_000);
    expect(niceDurationMax(100 * 60_000)).toBe(120 * 60_000);
  });

  it('lists every local day of a range, oldest first', () => {
    const to = new Date(2026, 9, 6, 15).getTime();
    const from = new Date(2026, 9, 3, 0).getTime();
    expect(dayKeys(from, to)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
    expect(dayKeys(0, to, 3)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(dayKey(to)).toBe('2026-10-06');
  });
});
