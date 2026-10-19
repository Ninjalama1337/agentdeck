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

const weekly = (pct: number, resetsAt: string): AgentUsage => ({
  agentId: 'claude',
  available: true,
  fetchedAt: 0,
  week: { pct, resetsAt },
});

const rateLimit = (pct: number, resetsAt: string): AgentUsage => ({
  agentId: 'claude',
  available: true,
  fetchedAt: 0,
  rateLimits: [{ name: 'Opus', window: { pct, resetsAt } }],
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

  it('re-arms only when the window clears, never on a drifting reset estimate', () => {
    const seen = new Map();
    limitCrossings(seen, [claude(85)]);
    // A drifting reset estimate must not re-arm a window that never reset.
    expect(limitCrossings(seen, [claude(85, undefined, '2026-10-15T19:00:00Z')])).toEqual([]);
    expect(limitCrossings(seen, [claude(85, undefined, '2026-10-15T21:00:00Z')])).toEqual([]);
    // A dip below the first warning line is the real reset: the next climb warns.
    limitCrossings(seen, [claude(79, undefined, '2026-10-15T21:00:00Z')]);
    expect(limitCrossings(seen, [claude(81, undefined, '2026-10-15T22:00:00Z')]).map((a) => a.level)).toEqual([80]);
  });

  it('announces a full weekly window exactly once however the reset time drifts', () => {
    const seen = new Map();
    const alerts = [
      limitCrossings(seen, [claude(0, 95, '2026-10-19T18:59:00Z')]),
      limitCrossings(seen, [claude(0, 100, '2026-10-19T18:59:00Z')]),
      limitCrossings(seen, [claude(0, 100, '2026-10-19T20:02:00Z')]),
      limitCrossings(seen, [claude(0, 100, '2026-10-19T20:59:00Z')]),
    ].flat();
    expect(alerts.map((a) => `${a.window}:${a.level}`)).toEqual(['weekly limit:95']);
  });

  it('keeps a full weekly window muted when the reset estimate only drifts', () => {
    const seen = new Map();
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(limitCrossings(seen, [weekly(100, '2026-10-26T18:00:00Z')], now).map((a) => a.level)).toEqual([95]);
    // +1 h and +2 h are ordinary drift, far below the ~7 d move of a real reset.
    expect(limitCrossings(seen, [weekly(100, '2026-10-26T19:00:00Z')], now + 3_600_000)).toEqual([]);
    expect(limitCrossings(seen, [weekly(100, '2026-10-26T20:00:00Z')], now + 7_200_000)).toEqual([]);
  });

  it('re-arms a full weekly window when the reset jumps to the next future week', () => {
    const seen = new Map();
    const t0 = Date.parse('2026-10-19T12:00:00Z');
    expect(
      limitCrossings(seen, [weekly(100, '2026-10-19T18:00:00Z')], t0).map((a) => `${a.window}:${a.level}`),
    ).toEqual(['weekly limit:95']);
    // The watcher was inactive while the window reset: the old reset now lies
    // in the past and the new one points at the following week.
    expect(
      limitCrossings(seen, [weekly(100, '2026-10-26T18:00:00Z')], Date.parse('2026-10-20T09:00:00Z')).map(
        (a) => `${a.window}:${a.level}`,
      ),
    ).toEqual(['weekly limit:95']);
  });

  it('re-arms a session window when the reset jumps by a full 5-hour period', () => {
    const seen = new Map();
    const t0 = Date.parse('2026-10-19T12:00:00Z');
    expect(
      limitCrossings(seen, [claude(90, undefined, '2026-10-19T13:00:00Z')], t0).map((a) => `${a.window}:${a.level}`),
    ).toEqual(['5-hour limit:90']);
    // Old window ended at 13:00; the next one ends five hours later.
    expect(
      limitCrossings(seen, [claude(90, undefined, '2026-10-19T18:00:00Z')], Date.parse('2026-10-19T13:30:00Z')).map(
        (a) => `${a.window}:${a.level}`,
      ),
    ).toEqual(['5-hour limit:90']);
  });

  it('still re-arms after a reading below the first warning line', () => {
    const seen = new Map();
    const t0 = Date.parse('2026-10-19T12:00:00Z');
    expect(limitCrossings(seen, [claude(96, 10, '2026-10-19T14:00:00Z')], t0).map((a) => a.level)).toEqual([95]);
    expect(limitCrossings(seen, [claude(12, 10, '2026-10-19T17:00:00Z')], t0 + 30 * 60_000)).toEqual([]);
    expect(
      limitCrossings(seen, [claude(83, 10, '2026-10-19T17:00:00Z')], t0 + 31 * 60_000).map(
        (a) => `${a.window}:${a.level}`,
      ),
    ).toEqual(['5-hour limit:80']);
  });

  it('does not guess rollovers for unknown rate-limit windows', () => {
    const seen = new Map();
    const t0 = Date.parse('2026-10-19T12:00:00Z');
    expect(limitCrossings(seen, [rateLimit(100, '2026-10-19T18:00:00Z')], t0).map((a) => a.level)).toEqual([95]);
    // A large jump is still not enough without a known window length.
    expect(limitCrossings(seen, [rateLimit(100, '2026-10-26T18:00:00Z')], Date.parse('2026-10-20T09:00:00Z'))).toEqual([]);
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
