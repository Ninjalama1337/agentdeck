import { describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { AntigravityAdapter, createAntigravityStreamParser } from '../src/agents/antigravity.js';
import type { ResolvedAgentConfig } from '../src/config.js';

const cfg: ResolvedAgentConfig = { mode: 'auto', command: 'agy' };

const session: Session = {
  id: 's_test',
  projectId: 'p_test',
  agentId: 'antigravity',
  title: 'test',
  status: 'running',
  permissionMode: 'default',
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

const RECORDED_LINES = [
  JSON.stringify({
    event: 'init',
    conversation_id: 'conv_123',
    init: { cwd: '/tmp/demo', tools: ['run_command', 'view_file'] },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv_123',
      step_index: 0,
      state: 'DONE',
      step_type: 'user_input',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv_123',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello! Let me run that command for you.\n',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv_123',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'ls -la' },
      },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv_123',
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        output: 'total 0\n',
      },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv_123',
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'The directory is empty.',
      usage: {
        input_tokens: 1500,
        output_tokens: 42,
        thinking_tokens: 20,
      },
    },
  }),
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conv_123',
      status: 'SUCCESS',
      response: 'The directory is empty.',
      usage: {
        input_tokens: 1500,
        output_tokens: 42,
        total_tokens: 1542,
      },
    },
  }),
];

describe('createAntigravityStreamParser', () => {
  it('parses real stream-json session events into normalized AgentEvents', () => {
    const parser = createAntigravityStreamParser();
    const events: AgentEvent[] = [];

    for (const line of RECORDED_LINES) {
      parser.parse(line, (ev) => events.push(ev));
    }

    expect(events).toEqual([
      { type: 'status', status: 'running', detail: 'Antigravity session initialized' },
      { type: 'text-delta', text: 'Hello! Let me run that command for you.\n' },
      { type: 'tool-use', tool: 'run_command', summary: 'ls -la' },
      { type: 'tool-result', tool: 'run_command', ok: true, summary: 'total 0\n' },
      { type: 'text-delta', text: 'The directory is empty.' },
      { type: 'usage', inputTokens: 1500, outputTokens: 42 },
      { type: 'usage', inputTokens: 1500, outputTokens: 42 },
    ]);
  });

  it('emits raw event for non-json output', () => {
    const parser = createAntigravityStreamParser();
    const events: AgentEvent[] = [];
    parser.parse('some random log message', (ev) => events.push(ev));
    expect(events).toEqual([{ type: 'raw', line: 'some random log message' }]);
  });
});

describe('AntigravityAdapter', () => {
  it('extracts conversation_id as external session id', () => {
    const adapter = new AntigravityAdapter(cfg);
    expect(adapter.externalSessionIdOf(RECORDED_LINES[0]!)).toBe('conv_123');
    expect(adapter.externalSessionIdOf(RECORDED_LINES[1]!)).toBe('conv_123');
    expect(adapter.externalSessionIdOf(RECORDED_LINES[6]!)).toBe('conv_123');
    expect(adapter.externalSessionIdOf('invalid json')).toBeUndefined();
  });

  it('builds run plan with -p and stream-json format', () => {
    const adapter = new AntigravityAdapter(cfg);
    const plan = adapter.buildRun({
      session,
      project,
      text: 'Build a game',
      attachments: [],
      model: 'Gemini 3.8 Pro',
      thinkingEffort: 'high',
      permissionMode: 'bypass',
      resumeId: 'conv_prev',
    });

    expect(plan.command).toBe('agy');
    expect(plan.args).toContain('-p');
    expect(plan.args).toContain('Build a game');
    expect(plan.args).toContain('--output-format');
    expect(plan.args).toContain('stream-json');
    expect(plan.args).toContain('--conversation');
    expect(plan.args).toContain('conv_prev');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('Gemini 3.8 Pro');
    expect(plan.args).toContain('--effort');
    expect(plan.args).toContain('high');
    expect(plan.args).toContain('--dangerously-skip-permissions');
    expect(plan.stdinPayloads).toBeNull();
    expect(plan.expectStream).toBe(true);
  });
});
