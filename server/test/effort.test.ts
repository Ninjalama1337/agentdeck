import { describe, expect, it } from 'vitest';
import {
  AGENT_EFFORTS,
  effortArg,
  parseEffortInput,
} from '../src/agents/effort.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { ResolvedAgentConfig } from '../src/config.js';
import type { RunContext } from '../src/agents/types.js';
import type { Project, Session } from '@agentdeck/shared';

const claudeCfg: ResolvedAgentConfig = { mode: 'headless', command: 'claude' };
const codexCfg: ResolvedAgentConfig = { mode: 'headless', command: 'codex' };

const project: Project = {
  id: 'p_test',
  name: 'demo',
  path: '/tmp/agentdeck-test-project',
  createdAt: 0,
  updatedAt: 0,
};

const session: Session = {
  id: 's_test',
  projectId: project.id,
  agentId: 'claude',
  title: 't',
  status: 'idle',
  permissionMode: 'acceptEdits',
  createdAt: 0,
  updatedAt: 0,
};

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    session,
    project,
    text: 'hi',
    attachments: [],
    ...overrides,
  } as RunContext;
}

describe('effort input parsing', () => {
  it('blank/undefined inherits (no effort)', () => {
    expect(parseEffortInput(undefined)).toEqual({ ok: true, effort: undefined });
    expect(parseEffortInput('')).toEqual({ ok: true, effort: undefined });
    expect(parseEffortInput('   ')).toEqual({ ok: true, effort: undefined });
  });

  it('accepts known levels case-insensitively', () => {
    expect(parseEffortInput('high')).toEqual({ ok: true, effort: 'high' });
    expect(parseEffortInput('LOW')).toEqual({ ok: true, effort: 'low' });
    expect(parseEffortInput('Adaptive')).toEqual({ ok: true, effort: 'adaptive' });
    expect(parseEffortInput('default')).toEqual({ ok: true, effort: 'default' });
  });

  it('rejects unknown values', () => {
    expect(parseEffortInput('ultra')).toEqual({ ok: false, value: 'ultra' });
    expect(parseEffortInput('11/10')).toEqual({ ok: false, value: '11/10' });
  });
});

describe('effortArg', () => {
  it('maps only low|medium|high to CLI levels', () => {
    expect(effortArg('high')).toBe('high');
    expect(effortArg('medium')).toBe('medium');
    expect(effortArg('low')).toBe('low');
    expect(effortArg('default')).toBeUndefined();
    expect(effortArg('adaptive')).toBeUndefined();
    expect(effortArg(undefined)).toBeUndefined();
  });
});

describe('adapter effort flags', () => {
  it('claude adds --effort <level> exactly once and omits for default', () => {
    const adapter = new ClaudeAdapter(claudeCfg);
    const withHigh = adapter.buildRun(ctx({ thinkingEffort: 'high' }));
    const flat = [...withHigh.args];
    const idx = flat.findIndex((a) => a === '--effort');
    expect(idx).toBeGreaterThan(-1);
    expect(flat[idx + 1]).toBe('high');
    expect(flat.filter((a) => a === '--effort')).toHaveLength(1);

    const without = adapter.buildRun(ctx({ thinkingEffort: 'default' }));
    expect(without.args).not.toContain('--effort');
    expect(adapter.buildRun(ctx()).args).not.toContain('--effort');
  });

  it('codex adds model_reasoning_effort config for levels only', () => {
    const adapter = new CodexAdapter(codexCfg);
    const withLow = adapter.buildRun(ctx({ thinkingEffort: 'low' }));
    const configArgs = withLow.args.filter(
      (a, i) => a === '-c' || String(withLow.args[i - 1]) === '-c',
    );
    expect(
      withLow.args.some((a) => String(a).includes('model_reasoning_effort="low"')),
    ).toBe(true);
    expect(configArgs).toHaveLength(2); // flag + value

    const without = adapter.buildRun(ctx({ thinkingEffort: 'adaptive' }));
    expect(
      without.args.some((a) => String(a).includes('model_reasoning_effort')),
    ).toBe(false);
  });

  it('effort survives a resume context', () => {
    const adapter = new ClaudeAdapter(claudeCfg);
    const resuming = adapter.buildRun(ctx({ thinkingEffort: 'medium', resumeId: 'abc' }));
    expect(resuming.args).toContain('--resume');
    expect(resuming.args).toContain('--effort');
  });

  it('AGENT_EFFORTS exposes default + CLI levels', () => {
    expect(AGENT_EFFORTS).toEqual(['default', 'low', 'medium', 'high']);
  });
});
