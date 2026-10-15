import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DailySummary, Project } from '@agentdeck/shared';
import { buildDailySummary, dayKey, digestText, DigestScheduler, serverTzOffset, startOfDay } from '../src/stats/digest.js';
import { StatsDb } from '../src/stats/db.js';

const log = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never;
const bucket = { runs: 0, ok: 0, errors: 0, stopped: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, toolCalls: 0 };

describe('day boundaries', () => {
  it('starts the day at local midnight', () => {
    const now = Date.parse('2026-10-15T21:30:00Z'); // 23:30 in UTC+2
    expect(new Date(startOfDay(now, 120)).toISOString()).toBe('2026-10-14T22:00:00.000Z');
    expect(dayKey(now, 120)).toBe('2026-10-15');
    expect(dayKey(Date.parse('2026-10-15T22:30:00Z'), 120)).toBe('2026-10-16');
  });
});

describe('digestText', () => {
  const base: DailySummary = { day: 'd', from: 0, to: 1, totals: bucket, byAgent: [], byProject: [], commits: [], highlights: [] };
  it('is silent on a quiet day', () => {
    expect(digestText(base)).toBeNull();
  });
  it('sums up agents, commits, failures and cost', () => {
    const t = digestText({
      ...base,
      totals: { ...bucket, runs: 5, errors: 1, costUsd: 3.456 },
      byAgent: [{ ...bucket, agentId: 'claude', runs: 4 }, { ...bucket, agentId: 'codex', runs: 1 }],
      commits: [{ projectId: 'p', projectName: 'agentdeck', count: 3, subjects: [] }],
    })!;
    expect(t.title).toBe('Today: 5 runs, 3 commits');
    expect(t.body).toBe('Claude Code 4 · Codex 1 — agentdeck: 3 commits — 1 failed — ≈ $3.46 API value');
  });
});

describe('buildDailySummary', () => {
  it('counts today\'s commits of each project', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-digest-'));
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, 'a'), '1');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'Add a']);
    const stats = await StatsDb.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-digest-db-')), 'stats.sqlite'), log);
    const project = { id: 'p1', name: 'demo', path: repo } as Project;
    const s = await buildDailySummary(stats, [project], Date.now(), serverTzOffset());
    expect(s.commits).toEqual([{ projectId: 'p1', projectName: 'demo', count: 1, subjects: ['Add a'] }]);
    stats.close();
  });
});

describe('DigestScheduler', () => {
  it('sends once after the set time, quiet days included', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-digest-set-'));
    let now = new Date(2026, 9, 15, 19, 59).getTime();
    const sent: string[] = [];
    let builds = 0;
    const d = new DigestScheduler({
      dataDir,
      now: () => now,
      log,
      build: async () => {
        builds++;
        return { day: 'x', from: 0, to: 0, totals: { ...bucket, runs: 2 }, byAgent: [], byProject: [], commits: [], highlights: [] };
      },
      notify: (t) => sent.push(t.title),
    });
    await d.tick();
    expect(builds).toBe(0);
    now = new Date(2026, 9, 15, 20, 1).getTime();
    await d.tick();
    await d.tick();
    expect(sent).toEqual(['Today: 2 runs, 0 commits']);
    // The next day again; switched off nothing.
    now = new Date(2026, 9, 16, 20, 5).getTime();
    d.set({ enabled: false });
    await d.tick();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'digest.json'), 'utf8'))).toMatchObject({ enabled: false, time: '20:00', lastSent: '2026-10-15' });
  });
});
