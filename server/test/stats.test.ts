import { describe, expect, it } from 'vitest';
import type { AgentUsage, RunRecord } from '@agentdeck/shared';
import { StatsDb } from '../src/stats/db.js';
import { sumTranscript } from '../src/stats/claudeTranscript.js';
import { createClaudeStreamParser } from '../src/agents/claude.js';

const HOUR = 3_600_000;
/** 2026-10-05 12:00 UTC */
const NOON = Date.UTC(2026, 9, 5, 12);

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: `run_${Math.random().toString(36).slice(2)}`,
    startedAt: NOON,
    endedAt: NOON + 60_000,
    agentId: 'claude',
    source: 'app',
    status: 'ok',
    ...over,
  };
}

async function filled(): Promise<StatsDb> {
  const db = await StatsDb.open(':memory:');
  db.recordRun(run({ model: 'claude-opus', projectId: 'p1', projectName: 'deck', inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, costUsd: 0.5, toolCalls: 3 }));
  db.recordRun(run({ startedAt: NOON + HOUR, endedAt: NOON + HOUR + 30_000, model: 'claude-opus', projectId: 'p1', projectName: 'deck', status: 'error', error: 'boom', inputTokens: 10, outputTokens: 5, costUsd: 0.1 }));
  db.recordRun(run({ startedAt: NOON + 11 * HOUR, endedAt: NOON + 11 * HOUR + 10_000, agentId: 'codex', source: 'routine', routineId: 'r1', projectId: 'p2', projectName: 'other', outputTokens: 7 }));
  db.recordRun(run({ startedAt: NOON + 12 * HOUR, endedAt: NOON + 12 * HOUR + 5_000, agentId: 'opencode', source: 'terminal', terminalId: 't1', status: 'stopped' }));
  return db;
}

describe('StatsDb', () => {
  it('sums runs per agent, model, project and source', async () => {
    const db = await filled();
    const s = db.summary({ from: NOON - HOUR, to: NOON + 24 * HOUR });
    expect(s.available).toBe(true);
    expect(s.totals).toMatchObject({ runs: 4, ok: 2, errors: 1, stopped: 1, inputTokens: 110, outputTokens: 62, cacheReadTokens: 1000, toolCalls: 3 });
    expect(s.totals.costUsd).toBeCloseTo(0.6);
    expect(s.totals.durationMs).toBe(60_000 + 30_000 + 10_000 + 5_000);
    expect(s.byAgent.map((a) => [a.agentId, a.runs])).toEqual([['claude', 2], ['codex', 1], ['opencode', 1]]);
    expect(s.byModel.find((m) => m.model === 'claude-opus')).toMatchObject({ agentId: 'claude', runs: 2, errors: 1 });
    expect(s.byProject.find((p) => p.projectId === 'p1')).toMatchObject({ projectName: 'deck', runs: 2 });
    expect(s.bySource.map((b) => b.source).sort()).toEqual(['app', 'routine', 'terminal']);
    expect(s.firstRunAt).toBe(NOON);
  });

  it('counts only the asked range and puts a day where the caller\'s clock has it', async () => {
    const db = await filled();
    expect(db.summary({ from: NOON + 2 * HOUR, to: NOON + 24 * HOUR }).totals.runs).toBe(2);
    // UTC: 23:00 and 00:00 fall on two days; two hours east they share the next day.
    const utc = db.summary({ from: 0, to: NOON + 24 * HOUR }).byDay.map((d) => [d.day, d.agentId, d.runs]);
    expect(utc).toEqual([
      ['2026-10-05', 'claude', 2],
      ['2026-10-05', 'codex', 1],
      ['2026-10-06', 'opencode', 1],
    ]);
    const berlin = db.summary({ from: 0, to: NOON + 24 * HOUR, tzOffset: 120 }).byDay.map((d) => [d.day, d.agentId]);
    expect(berlin).toEqual([
      ['2026-10-05', 'claude'],
      ['2026-10-06', 'codex'],
      ['2026-10-06', 'opencode'],
    ]);
  });

  it('lists runs newest first, in pages, and by routine', async () => {
    const db = await filled();
    const first = db.runs({ limit: 3 });
    expect(first.runs.map((r) => r.agentId)).toEqual(['opencode', 'codex', 'claude']);
    expect(first.next).toBe(NOON + HOUR);
    const rest = db.runs({ limit: 3, before: first.next });
    expect(rest.runs).toHaveLength(1);
    expect(rest.next).toBeUndefined();
    expect(first.runs[2]).toMatchObject({ status: 'error', error: 'boom', projectName: 'deck', inputTokens: 10 });
    expect(first.runs[0]?.inputTokens).toBeUndefined();
    expect(db.runs({ routineId: 'r1' }).runs.map((r) => r.agentId)).toEqual(['codex']);
  });

  it('keeps a subscription reading when it moved, and otherwise once an hour', async () => {
    const db = await StatsDb.open(':memory:');
    const usage = (pct: number): AgentUsage[] => [
      { agentId: 'claude', available: true, plan: 'Max', session: { pct, resetsAt: '2026-10-05T17:00:00.000Z' }, week: { pct: 40 }, fetchedAt: 0 },
      { agentId: 'codex', available: false, fetchedAt: 0 },
    ];
    db.recordPlans(usage(10), NOON);
    db.recordPlans(usage(10), NOON + 60_000); // unchanged a minute later
    db.recordPlans(usage(12), NOON + 120_000); // moved
    db.recordPlans(usage(12), NOON + 2 * HOUR); // unchanged, but an hour passed
    const s = db.summary({ from: NOON - HOUR, to: NOON + 24 * HOUR });
    expect(s.plans).toEqual([
      { agentId: 'claude', ts: NOON + 2 * HOUR, plan: 'Max', sessionPct: 12, weekPct: 40, sessionResetsAt: '2026-10-05T17:00:00.000Z' },
    ]);
    // One point per hour: the first hour keeps its latest reading.
    expect(s.planHistory.map((p) => [p.ts, p.sessionPct])).toEqual([
      [NOON + 120_000, 12],
      [NOON + 2 * HOUR, 12],
    ]);
  });
});

describe('sumTranscript', () => {
  const line = (id: string, ts: number, usage: Record<string, number>, content: unknown[] = [], model = 'claude-opus-5-5') =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, model, content, usage } });

  it('adds up the messages of the turn — each once, with its last numbers', () => {
    const text = [
      line('old', NOON - 5000, { input_tokens: 999, output_tokens: 999 }),
      JSON.stringify({ type: 'user', timestamp: new Date(NOON).toISOString(), message: { content: 'assistant' } }),
      line('m1', NOON + 1000, { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, [{ type: 'thinking' }]),
      line('m1', NOON + 2000, { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, [{ type: 'tool_use', id: 'tu1' }]),
      line('m2', NOON + 3000, { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 200 }, [{ type: 'text' }], 'claude-haiku'),
      '{broken',
    ].join('\n');
    expect(sumTranscript(text, NOON)).toEqual({
      inputTokens: 5,
      outputTokens: 35,
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
      toolCalls: 1,
      model: 'claude-opus-5-5',
    });
  });

  it('says nothing when the turn left no message', () => {
    expect(sumTranscript(line('old', NOON - 5000, { output_tokens: 1 }), NOON)).toBeUndefined();
  });
});

describe('Claude result line', () => {
  it('reports cache tokens and the model that really ran', () => {
    const events: unknown[] = [];
    createClaudeStreamParser().parse(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        total_cost_usd: 0.02,
        usage: { input_tokens: 18, output_tokens: 178, cache_read_input_tokens: 34693, cache_creation_input_tokens: 8894 },
        modelUsage: { 'claude-haiku-4-5': { outputTokens: 170 }, 'claude-opus-5-5': { outputTokens: 8 } },
      }),
      (e) => events.push(e),
    );
    expect(events[0]).toEqual({
      type: 'usage',
      inputTokens: 18,
      outputTokens: 178,
      cacheReadTokens: 34693,
      cacheWriteTokens: 8894,
      costUsd: 0.02,
      model: 'claude-haiku-4-5',
    });
  });
});
