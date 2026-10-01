import { describe, expect, it } from 'vitest';
import {
  parseAntigravityUsage,
  parseClaudeUsage,
  parseOpenCodeUsage,
  UsageCollector,
  type SpawnResult,
  type UsageSpawn,
} from '../src/usage/collector.js';

const CLAUDE_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 1% used · resets Sep 30, 1:19pm (Europe/Berlin)
Current week (all models): 24% used · resets Oct 5, 8:59pm (Europe/Berlin)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 349 requests · 6 sessions
  84% of your usage was at >150k context
  Top MCP servers: opencode 92%

Last 7d · 503 requests · 9 sessions
  72% of your usage was at >150k context
`;

const AGY_SAMPLE = `Quota:
Gemini Models          Weekly Limit Remaining     95%   2026-10-05T17:22:36Z
Gemini Models          Five Hour Limit Remaining  68%   2026-09-30T21:45:18Z
Claude and GPT models  Weekly Limit Remaining     100%  2026-10-07T17:36:34Z
Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-30T22:36:34Z
`;

const OPENCODE_SAMPLE = `┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                            135 │
│Messages                                          8,282 │
│Days                                                 71 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                       $30.54 │
│Avg Cost/Day                                      $0.43 │
│Avg Tokens/Session                                 9.9M │
│Median Tokens/Session                              1.0M │
│Input                                             48.8M │
│Output                                             2.9M │
│Cache Read                                      1280.2M │
│Cache Write                                      101.6K │
└────────────────────────────────────────────────────────┘
`;

describe('parseClaudeUsage', () => {
  it('parses the recorded sample completely', () => {
    const parsed = parseClaudeUsage(CLAUDE_SAMPLE);
    expect(parsed.available).toBe(true);
    expect(parsed.plan).toBe('Claude subscription');
    expect(parsed.session?.pct).toBe(1);
    expect(parsed.session?.resetsAt).toBe('Sep 30, 13:19');
    expect(parsed.week?.pct).toBe(24);
    expect(parsed.week?.resetsAt).toBe('Oct 5, 20:59');
    expect(parsed.last24h).toEqual({ requests: 349, sessions: 6 });
    expect(parsed.last7d).toEqual({ requests: 503, sessions: 9 });
  });

  it('parses partial output without throwing', () => {
    const partial = 'Current week (all models): 77% used · resets Nov 1, 9:00am';
    const parsed = parseClaudeUsage(partial);
    expect(parsed.available).toBe(true);
    expect(parsed.week?.pct).toBe(77);
    expect(parsed.session).toBeUndefined();
    expect(parsed.last24h).toBeUndefined();
  });

  it('marks assistant-style output unavailable', () => {
    const garbage =
      '"usage" on its own is a bit ambiguous, so here are the likely meanings: ...';
    const parsed = parseClaudeUsage(garbage);
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toContain('unexpected CLI output');
  });
});

describe('parseAntigravityUsage', () => {
  it('parses Gemini and Claude limit percentages and reset timestamps', () => {
    const parsed = parseAntigravityUsage(AGY_SAMPLE);
    expect(parsed.available).toBe(true);
    // 68% remaining -> 32% used
    expect(parsed.session?.pct).toBe(32);
    // 95% remaining -> 5% used
    expect(parsed.week?.pct).toBe(5);
    expect(parsed.modelsQuota).toBeDefined();
    expect(parsed.modelsQuota?.length).toBe(2);
    expect(parsed.modelsQuota?.[0].name).toBe('Gemini Models');
    expect(parsed.modelsQuota?.[0].sessionLimit?.pct).toBe(32);
    expect(parsed.modelsQuota?.[1].name).toBe('Claude & GPT Models');
    expect(parsed.modelsQuota?.[1].sessionLimit?.pct).toBe(0);
  });

  it('marks invalid quota output unavailable', () => {
    const parsed = parseAntigravityUsage('Unknown error occurred');
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toContain('unexpected CLI output');
  });
});

describe('parseOpenCodeUsage', () => {
  it('parses cost, sessions, messages and token stats', () => {
    const parsed = parseOpenCodeUsage(OPENCODE_SAMPLE);
    expect(parsed.available).toBe(true);
    expect(parsed.cost).toBe('$30.54');
    expect(parsed.session?.sessions).toBe(135);
    expect(parsed.session?.requests).toBe(8282);
    expect(parsed.tokens?.input).toBe('48.8M');
    expect(parsed.tokens?.output).toBe('2.9M');
    expect(parsed.tokens?.cache).toBe('1280.2M');
  });

  it('marks unexpected output unavailable', () => {
    const parsed = parseOpenCodeUsage('command not found');
    expect(parsed.available).toBe(false);
  });
});

function ok(stdout: string): SpawnResult {
  return { stdout, stderr: '' };
}

describe('UsageCollector', () => {
  const agents = {
    infoOf: (id: string) => ({ available: true }) as never,
  };

  function collector(spawn: UsageSpawn) {
    return new UsageCollector({
      agents,
      isAvailable: (id) => ['claude', 'antigravity', 'opencode', 'codex', 'zcode'].includes(id),
      spawn,
    });
  }

  it('collects all 5 agents (claude, agy, opencode, codex, zcode)', async () => {
    let calls = 0;
    const c = collector(async (cmd: string, args: string[]) => {
      calls += 1;
      if (cmd === 'claude') return ok(CLAUDE_SAMPLE);
      if (cmd === 'agy') return ok(AGY_SAMPLE);
      if (cmd === 'opencode') return ok(OPENCODE_SAMPLE);
      if (cmd === 'codex') return ok('Logged in using ChatGPT');
      if (cmd === 'zcode') return ok('0.16.9');
      return ok('');
    });
    const result = await c.collect();
    expect(result).toHaveLength(5);

    const claude = result.find((r) => r.agentId === 'claude');
    expect(claude?.available).toBe(true);
    expect(claude?.session?.pct).toBe(1);

    const agy = result.find((r) => r.agentId === 'antigravity');
    expect(agy?.available).toBe(true);
    expect(agy?.session?.pct).toBe(32);

    const opencode = result.find((r) => r.agentId === 'opencode');
    expect(opencode?.available).toBe(true);
    expect(opencode?.cost).toBe('$30.54');

    const codex = result.find((r) => r.agentId === 'codex');
    expect(codex?.available).toBe(true);
    expect(codex?.plan).toBe('Logged in using ChatGPT');

    const zcode = result.find((r) => r.agentId === 'zcode');
    expect(zcode?.available).toBe(true);

    expect(calls).toBe(5);
  });

  it('caches within TTL and dedupes concurrent calls', async () => {
    let spawns = 0;
    const c = collector(async (cmd: string) => {
      spawns += 1;
      if (cmd === 'claude') return ok(CLAUDE_SAMPLE);
      if (cmd === 'agy') return ok(AGY_SAMPLE);
      if (cmd === 'opencode') return ok(OPENCODE_SAMPLE);
      if (cmd === 'codex') return ok('Logged in using ChatGPT');
      if (cmd === 'zcode') return ok('0.16.9');
      return ok('');
    });
    const [a, b] = await Promise.all([c.collect(), c.collect()]);
    expect(a).toEqual(b);
    expect(spawns).toBe(5);
    await c.collect();
    expect(spawns).toBe(5); // cache hit
  });

  it('degrades gracefully on spawn errors', async () => {
    const c = collector(async () => {
      throw new Error('boom');
    });
    const result = await c.collect();
    const claude = result.find((r) => r.agentId === 'claude');
    expect(claude?.available).toBe(false);
    expect(claude?.reason).toContain('failed');
  });
});
