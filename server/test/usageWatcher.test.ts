import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    expect(limitCrossings(seen, [claude(96, 85)]).map((a) => `${a.window}:${a.level}`)).toEqual(['5-hour limit:95', 'weekly limit:80']);
    expect(limitCrossings(seen, [claude(96, 92)]).map((a) => `${a.window}:${a.level}`)).toEqual(['weekly limit:90']);
    expect(limitCrossings(seen, [claude(96, 92)])).toEqual([]);
    // 100 % is not a level of its own any more — the window already warned at 95.
    expect(limitCrossings(seen, [claude(100, 92)])).toEqual([]);
  });

  it('re-arms only when the window rolls over, never on a dip below a level', () => {
    const seen = new Map();
    limitCrossings(seen, [claude(85)]);
    expect(limitCrossings(seen, [claude(85, undefined, '2026-10-15T19:00:00Z')]).map((a) => a.level)).toEqual([80]);
    // Same window: falling back below the line and climbing again does not warn twice.
    limitCrossings(seen, [claude(70, undefined, '2026-10-15T19:00:00Z')]);
    expect(limitCrossings(seen, [claude(81, undefined, '2026-10-15T19:00:00Z')])).toEqual([]);
    // The next rollover re-arms it again.
    expect(limitCrossings(seen, [claude(81, undefined, '2026-10-15T23:00:00Z')]).map((a) => a.level)).toEqual([80]);
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

  it('keeps what it announced across a restart (state file)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-usage-alerts-'));
    const stateFile = path.join(dir, 'usage-alerts.json');
    try {
      const first: LimitAlert[] = [];
      const w1 = new UsageWatcher({
        collect: async () => [claude(90)],
        active: () => true,
        notify: (a) => first.push(a),
        stateFile,
      });
      await w1.tick();
      expect(first).toHaveLength(1);

      // A fresh process (update, crash) over the same file must stay quiet.
      const second: LimitAlert[] = [];
      const w2 = new UsageWatcher({
        collect: async () => [claude(90)],
        active: () => true,
        notify: (a) => second.push(a),
        stateFile,
      });
      await w2.tick();
      expect(second).toHaveLength(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
