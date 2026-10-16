import { describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { OpenCodeAdapter, createOpenCodeStreamParser } from '../src/agents/opencode.js';
import type { ResolvedAgentConfig } from '../src/config.js';

const cfg: ResolvedAgentConfig = { mode: 'auto', command: 'opencode' };

const session: Session = {
  id: 's_test',
  projectId: 'p_test',
  agentId: 'opencode',
  title: 'test',
  status: 'running',
  permissionMode: 'bypass',
  createdAt: 1,
  updatedAt: 1,
};

const project: Project = {
  id: 'p_test',
  name: 'demo',
  path: '/tmp/demo',
  createdAt: 1,
  updatedAt: 1,
};

const part = (id: string, body: Record<string, unknown>): string =>
  JSON.stringify({ type: body['type'] ?? 'text', sessionID: 'ses_x', part: { id, ...body } });

// Shapes captured from `opencode run --format json` (v1.18.x).
const RECORDED_LINES = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_x', part: { id: 'prt_1', type: 'step-start' } }),
  JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_x',
    part: {
      id: 'prt_2',
      type: 'tool',
      tool: 'read',
      callID: 'call_1',
      state: { status: 'completed', input: { filePath: '/tmp/demo/hello.txt' }, title: 'tmp/demo/hello.txt' },
    },
  }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_x',
    part: {
      id: 'prt_3',
      type: 'step-finish',
      reason: 'tool-calls',
      tokens: { input: 9297, output: 45, reasoning: 0, cache: { read: 1792, write: 0 } },
      cost: 1,
    },
  }),
  JSON.stringify({ type: 'step_start', sessionID: 'ses_x', part: { id: 'prt_4', type: 'step-start' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { id: 'prt_5', type: 'text', text: 'hello-from-file' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_x',
    part: {
      id: 'prt_6',
      type: 'step-finish',
      reason: 'stop',
      tokens: { input: 178, output: 4, reasoning: 0, cache: { read: 11008, write: 0 } },
      cost: 2,
    },
  }),
];

describe('createOpenCodeStreamParser', () => {
  it('turns the JSON event stream into normalized AgentEvents', () => {
    const parser = createOpenCodeStreamParser();
    const events: AgentEvent[] = [];
    for (const line of RECORDED_LINES) parser.parse(line, (ev) => events.push(ev));

    expect(events).toEqual([
      { type: 'tool-use', tool: 'read', summary: '/tmp/demo/hello.txt' },
      { type: 'tool-result', tool: 'read', ok: true, summary: 'tmp/demo/hello.txt' },
      { type: 'usage', inputTokens: 9297, outputTokens: 45, cacheReadTokens: 1792, cacheWriteTokens: 0, costUsd: 1 },
      { type: 'text-delta', text: 'hello-from-file' },
      { type: 'usage', inputTokens: 9475, outputTokens: 49, cacheReadTokens: 12800, cacheWriteTokens: 0, costUsd: 3 },
    ]);
  });

  it('streams only the new suffix when a part grows across events', () => {
    const parser = createOpenCodeStreamParser();
    const events: AgentEvent[] = [];
    parser.parse(part('prt_1', { type: 'text', text: 'hel' }), (ev) => events.push(ev));
    parser.parse(part('prt_1', { type: 'text', text: 'hello' }), (ev) => events.push(ev));
    parser.parse(part('prt_1', { type: 'text', text: 'hello' }), (ev) => events.push(ev));
    expect(events).toEqual([{ type: 'text-delta', text: 'hel' }, { type: 'text-delta', text: 'lo' }]);
  });

  it('emits raw for non-json output', () => {
    const parser = createOpenCodeStreamParser();
    const events: AgentEvent[] = [];
    parser.parse('not json', (ev) => events.push(ev));
    expect(events).toEqual([{ type: 'raw', line: 'not json' }]);
  });
});

describe('OpenCodeAdapter', () => {
  it('extracts the opencode session id for resume', () => {
    const adapter = new OpenCodeAdapter(cfg);
    expect(adapter.externalSessionIdOf(RECORDED_LINES[0]!)).toBe('ses_x');
    expect(adapter.externalSessionIdOf('invalid')).toBeUndefined();
  });

  it('supports images and resume', () => {
    const adapter = new OpenCodeAdapter(cfg);
    expect(adapter.capabilities()).toMatchObject({ headless: true, images: true, resume: true, streaming: true });
  });

  it('builds an args run with json events, attachments and the prompt after --', () => {
    const adapter = new OpenCodeAdapter(cfg);
    const plan = adapter.buildRun({
      session,
      project,
      text: 'Hello',
      attachments: [{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 1 }],
      model: 'zai/coder',
      permissionMode: 'bypass',
      resumeId: 'ses_prev',
    });

    expect(plan.command).toBe('opencode');
    expect(plan.args).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      'zai/coder',
      '-s',
      'ses_prev',
      '--file=/tmp/a.png',
      '--',
      'Hello',
    ]);
    expect(plan.stdinPayloads).toBeNull();
    expect(plan.expectStream).toBe(true);
  });

  it('omits --auto and resume when not bypassing and nothing to resume', () => {
    const adapter = new OpenCodeAdapter(cfg);
    const plan = adapter.buildRun({
      session: { ...session, permissionMode: 'default' },
      project,
      text: 'Hi',
      attachments: [],
      permissionMode: 'default',
    });
    expect(plan.args).toEqual(['run', '--format', 'json', '--', 'Hi']);
  });
});
