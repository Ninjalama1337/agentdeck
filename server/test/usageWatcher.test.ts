import { describe, expect, it } from 'vitest';
import type { AgentUsage } from '@agentdeck/shared';
import { alertText, limitCrossings, UsageWatcher, type LimitAlert } from '../src/usage/watcher.js';

const claude = (session?: number, week?: number, resetsAt = '2026-10-15T14:00:00Z'): AgentUsage => ({
  agentId: 'claude',
  available: true,
  fetchedAt: 0,
  ...(session !== undefined ? { session: { pct: session, resetsAt } } : {}),
  ...(week !== undefined ? { week: { pct: week } } : {}),
});

describe('limitCrossings', () => {
  it('warns once per level and window', () => {
    const seen = new Map();
    expect(limitCrossings(seen, [claude(50, 10)])).toEqual([]);
    expect(limitCrossings(seen, [claude(82, 10)]).map((a) => a.level)).toEqual([80]);
    expect(limitCrossings(seen, [claude(88, 10)])).toEqual([]);
    expect(limitCrossings(seen, [claude(96, 81)]).map((a) => `${a.window}:${a.level}`)).toEqual(['5-hour limit:95', 'weekly limit:80']);
    expect(limitCrossings(seen, [claude(100, 81)]).map((a) => a.level)).toEqual([100]);
  });

  it('re-arms when the window rolls over or usage drops below the level', () => {
    const seen = new Map();
    limitCrossings(seen, [claude(85)]);
    expect(limitCrossings(seen, [claude(85, undefined, '2026-10-15T19:00:00Z')]).map((a) => a.level)).toEqual([80]);
    limitCrossings(seen, [claude(70, undefined, '2026-10-15T19:00:00Z')]);
    expect(limitCrossings(seen, [claude(81, undefined, '2026-10-15T19:00:00Z')]).map((a) => a.level)).toEqual([80]);
  });
});

describe('alertText', () => {
  it('names agent, window and the time to the reset', () => {
    const now = Date.parse('2026-10-15T11:47:00Z');
    const t = alertText({ agentId: 'claude', window: 'weekly limit', pct: 96, level: 95, resetsAt: '2026-10-15T14:00:00Z' }, now);
    expect(t.title).toBe('Claude Code: weekly limit at 96%');
    expect(t.body).toMatch(/^Resets in 2 h 13 min\./);
    expect(alertText({ agentId: 'codex', window: '5-hour limit', pct: 100, level: 100 }).title).toMatch(/used up$/);
  });
});

describe('UsageWatcher', () => {
  it('reads only while agents are active and records every reading', async () => {
    let active = false;
    const recorded: number[] = [];
    const alerts: LimitAlert[] = [];
    const w = new UsageWatcher({
      collect: async () => [claude(90)],
      record: (u) => recorded.push(u.length),
      active: () => active,
      notify: (a) => alerts.push(a),
    });
    await w.tick();
    expect(recorded).toEqual([]);
    active = true;
    await w.tick();
    await w.tick();
    expect(recorded).toEqual([1, 1]);
    expect(alerts).toHaveLength(1);
  });
});
