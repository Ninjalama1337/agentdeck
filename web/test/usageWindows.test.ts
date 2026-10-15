import { describe, expect, it } from 'vitest';
import type { AgentUsage } from '@agentdeck/shared';
import {
  countdown,
  limitWindows,
  pctLabel,
  shortWindowLabel,
  sortByTightest,
  tightestWindow,
  usageWarnings,
} from '../src/util/usageWindows';

const usage = (agentId: AgentUsage['agentId'], extra: Partial<AgentUsage> = {}): AgentUsage => ({
  agentId,
  available: true,
  fetchedAt: 0,
  ...extra,
});

describe('limitWindows', () => {
  it('lists session, week and provider windows that have a number', () => {
    const u = usage('codex', {
      session: { pct: 34.4, resetsAt: '2026-10-15T14:00:00Z' },
      week: { resetsAt: '2026-10-20T00:00:00Z' },
      rateLimits: [{ name: 'Weekly limit', window: { pct: 120 } }],
    });
    expect(limitWindows(u)).toEqual([
      { key: 'session', label: 'Session limit', short: '5h', pct: 34, resetsAt: '2026-10-15T14:00:00Z' },
      { key: 'rl:Weekly limit', label: 'Weekly limit', short: 'wk', pct: 100 },
    ]);
    expect(tightestWindow(u)?.key).toBe('rl:Weekly limit');
    expect(tightestWindow(usage('claude'))).toBeNull();
  });

  it('shortens provider window names', () => {
    expect(shortWindowLabel('5h limit')).toBe('5h');
    expect(shortWindowLabel('Monthly')).toBe('mo');
    expect(shortWindowLabel('Primary')).toBe('5h');
  });
});

describe('sortByTightest', () => {
  it('puts the fullest limit first, agents without numbers after, unavailable last', () => {
    const list = [
      usage('opencode', { available: false }),
      usage('zcode'),
      usage('claude', { session: { pct: 40 }, week: { pct: 91 } }),
      usage('codex', { session: { pct: 60 } }),
    ];
    expect(sortByTightest(list).map((u) => u.agentId)).toEqual(['claude', 'codex', 'zcode', 'opencode']);
  });
});

describe('countdown', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  it('counts down minutes, hours and days', () => {
    expect(countdown('2026-10-15T12:45:00Z', now)).toBe('45m');
    expect(countdown('2026-10-15T14:07:00Z', now)).toBe('2h 07m');
    expect(countdown('2026-10-18T16:00:00Z', now)).toBe('3d 4h');
  });
  it('says now for a past reset and nothing for text', () => {
    expect(countdown('2026-10-15T11:00:00Z', now)).toBe('now');
    expect(countdown('3pm (Europe/Berlin)', now)).toBeNull();
    expect(countdown(undefined, now)).toBeNull();
  });
});

describe('display and warnings', () => {
  it('reads used or left', () => {
    expect(pctLabel(83, 'used')).toBe('83% used');
    expect(pctLabel(83, 'left')).toBe('17% left');
  });
  it('warns from 80 %, fullest first', () => {
    const w = usageWarnings([
      usage('claude', { session: { pct: 80 }, week: { pct: 50 } }),
      usage('codex', { week: { pct: 97 } }),
    ]);
    expect(w.map((x) => `${x.agentId}:${x.window.key}`)).toEqual(['codex:week', 'claude:session']);
  });
});
