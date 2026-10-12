import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseOpenCodeGoUsage,
  readOpenCodeGoApiKey,
} from '../src/agents/opencodeGo.js';

const GO_SAMPLE = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-12T20:02:30.000Z' },
    weekly: { status: 'ok', percent: 8, resetsAt: '2026-10-19T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 6, resetsAt: '2026-11-09T09:30:15.000Z' },
  },
};

describe('parseOpenCodeGoUsage', () => {
  it('maps rolling/weekly/monthly to session/week/monthly', () => {
    const parsed = parseOpenCodeGoUsage(GO_SAMPLE);
    expect(parsed.available).toBe(true);
    expect(parsed.plan).toBe('OpenCode Go subscription');
    expect(parsed.session?.pct).toBe(1);
    expect(parsed.session?.resetsAt).toBe('2026-10-12T20:02:30.000Z');
    expect(parsed.week?.pct).toBe(8);
    expect(parsed.monthly?.pct).toBe(6);
  });

  it('clamps percents and tolerates partial windows', () => {
    const parsed = parseOpenCodeGoUsage({ usage: { rolling: { status: 'ok', percent: 140 } } });
    expect(parsed.available).toBe(true);
    expect(parsed.session?.pct).toBe(100);
    expect(parsed.week).toBeUndefined();
    expect(parsed.monthly).toBeUndefined();
  });

  it('marks a missing plan unavailable', () => {
    const parsed = parseOpenCodeGoUsage({ usage: {} });
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toContain('no active usage windows');
  });
});

describe('readOpenCodeGoApiKey', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function authFile(contents: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-opencode-'));
    dirs.push(dir);
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, JSON.stringify(contents));
    return file;
  }

  it('prefers the opencode-go entry over opencode', () => {
    const file = authFile({ opencode: { type: 'api', key: 'zen' }, 'opencode-go': { type: 'api', key: 'go' } });
    expect(readOpenCodeGoApiKey(file)).toBe('go');
  });

  it('falls back to the opencode (Zen) entry', () => {
    const file = authFile({ opencode: { type: 'api', key: 'zen' } });
    expect(readOpenCodeGoApiKey(file)).toBe('zen');
  });

  it('returns undefined without an auth store', () => {
    expect(readOpenCodeGoApiKey(path.join(os.tmpdir(), 'agentdeck-missing-auth.json'))).toBeUndefined();
  });
});
