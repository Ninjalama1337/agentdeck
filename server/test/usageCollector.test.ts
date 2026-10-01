import { describe, expect, it } from 'vitest';
import {
  parseClaudeUsage,
  UsageCollector,
  type SpawnResult,
  type UsageSpawn,
} from '../src/usage/collector.js';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

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

describe('parseClaudeUsage', () => {
  it('parses the recorded sample completely', () => {
    const parsed = parseClaudeUsage(SAMPLE);
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
      isAvailable: (id) => id === 'claude' || id === 'codex',
      spawn,
    });
  }

  it('collects claude + codex and marks IDE agents unavailable', async () => {
    let calls = 0;
    const c = collector(async (_cmd: string, args: string[]) => {
      calls += 1;
      if (args.join(' ').includes('/usage')) return ok(SAMPLE);
      return ok('Logged in using ChatGPT');
    });
    const result = await c.collect();
    expect(result).toHaveLength(4);
    const claude = result.find((r) => r.agentId === 'claude');
    expect(claude?.available).toBe(true);
    expect(claude?.session?.pct).toBe(1);
    expect(claude?.week?.pct).toBe(24);
    const codex = result.find((r) => r.agentId === 'codex');
    expect(codex?.available).toBe(true);
    expect(codex?.plan).toBe('Logged in using ChatGPT');
    expect(result.find((r) => r.agentId === 'zcode')?.available).toBe(false);
    expect(result.find((r) => r.agentId === 'antigravity')?.available).toBe(false);
    expect(calls).toBe(2);
  });

  it('caches within TTL and dedupes concurrent calls', async () => {
    let spawns = 0;
    const c = collector(async (_cmd: string, args: string[]) => {
      spawns += 1;
      if (args.join(' ').includes('/usage')) return ok(SAMPLE);
      return ok('Logged in using ChatGPT');
    });
    const [a, b] = await Promise.all([c.collect(), c.collect()]);
    expect(a).toEqual(b);
    expect(spawns).toBe(2); // one claude + one codex, shared by both calls
    await c.collect();
    expect(spawns).toBe(2); // cache hit
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

  it('collects zcode when available and supports plan choices', async () => {
    const c = new UsageCollector({
      agents,
      isAvailable: (id) => id === 'zcode',
      zcodeCollector: async () => ({
        plan: 'GLM Coding Lite (Abo)',
        activePlanId: 'subscription',
        plans: [
          { id: 'subscription', label: 'GLM Coding Lite (Abo)', active: true },
          { id: 'free', label: 'Free Tokens (Start-Plan)', active: false },
        ],
      }),
    });
    const result = await c.collect();
    const zcode = result.find((r) => r.agentId === 'zcode');
    expect(zcode?.available).toBe(true);
    expect(zcode?.plan).toBe('GLM Coding Lite (Abo)');
    expect(zcode?.activePlanId).toBe('subscription');
    expect(zcode?.plans).toHaveLength(2);
  });

  it('clears cache on clearCache()', async () => {
    let callCount = 0;
    const c = new UsageCollector({
      agents,
      isAvailable: (id) => id === 'zcode',
      zcodeCollector: async () => {
        callCount++;
        return { plan: `Plan ${callCount}` };
      },
    });
    const r1 = await c.collect();
    expect(r1.find((r) => r.agentId === 'zcode')?.plan).toBe('Plan 1');
    const r2 = await c.collect();
    expect(r2.find((r) => r.agentId === 'zcode')?.plan).toBe('Plan 1'); // cached
    c.clearCache();
    const r3 = await c.collect();
    expect(r3.find((r) => r.agentId === 'zcode')?.plan).toBe('Plan 2'); // fresh
  });
});
