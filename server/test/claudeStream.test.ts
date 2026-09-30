import { describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type { ResolvedAgentConfig } from '../src/config.js';

const cfg: ResolvedAgentConfig = { mode: 'headless', command: 'claude' };

const session: Session = {
  id: 's_test',
  projectId: 'p_test',
  agentId: 'claude',
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
    type: 'system',
    subtype: 'init',
    session_id: 'c123',
    model: 'claude-sonnet-4-6',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look at the file. ' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/tmp/demo/index.ts', limit: 5 },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export {};' }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The file is empty.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'The file is empty.',
    session_id: 'c123',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 120, output_tokens: 45 },
  }),
];

function feed(adapter: ClaudeAdapter): { events: AgentEvent[]; externalId?: string } {
  let externalId: string | undefined;
  const events: AgentEvent[] = [];
  const plan = adapter.buildRun({
    session,
    project,
    text: 'Explain index.ts',
    attachments: [],
    permissionMode: 'default',
  });
  for (const line of RECORDED_LINES) {
    const found = adapter.externalSessionIdOf?.(line);
    if (found) externalId = found;
    plan.parse(line, (event) => events.push(event));
  }
  return { events, externalId };
}

describe('Claude Code stream-json parsing', () => {
  it('emits the expected normalized event sequence', () => {
    const { events } = feed(new ClaudeAdapter(cfg));

    // First event: init status
    expect(events[0]).toMatchObject({ type: 'status', status: 'running' });

    // Text deltas accumulate to the assistant answer
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e.type === 'text-delta' ? e.text : ''))
      .join('');
    expect(text).toBe('Let me look at the file. The file is empty.');

    // tool-use with a compact input summary
    const toolUse = events.find((e) => e.type === 'tool-use');
    expect(toolUse).toMatchObject({ type: 'tool-use', tool: 'Read' });
    expect((toolUse as { summary?: string }).summary).toContain('/tmp/demo/index.ts');

    // tool-result matched to the tool name via tool_use_id
    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({ type: 'tool-result', tool: 'Read', ok: true });

    // usage from the result event
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      type: 'usage',
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.0123,
    });
  });

  it('captures the external session id for resume', () => {
    const { externalId } = feed(new ClaudeAdapter(cfg));
    expect(externalId).toBe('c123');
  });

  it('flags error results via a status event', () => {
    const adapter = new ClaudeAdapter(cfg);
    const events: AgentEvent[] = [];
    const plan = adapter.buildRun({
      session,
      project,
      text: 'x',
      attachments: [],
      permissionMode: 'bypass',
    });
    plan.parse(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      (event) => events.push(event),
    );
    const status = events.find((e) => e.type === 'status');
    expect(status).toMatchObject({ type: 'status', status: 'error' });
  });

  it('maps the bypass permission mode to bypassPermissions and builds sane argv', () => {
    const adapter = new ClaudeAdapter(cfg);
    const plan = adapter.buildRun({
      session,
      project,
      text: 'hi',
      attachments: [],
      permissionMode: 'bypass',
      model: 'opus',
      resumeId: 'c123',
    });
    expect(plan.command).toBe('claude');
    expect(plan.args).toContain('--permission-mode');
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(plan.args).toEqual(
      expect.arrayContaining(['--model', 'opus', '--resume', 'c123', '-p', '--verbose']),
    );
    expect(plan.stdinPayloads).toHaveLength(1);
    const payload = JSON.parse(plan.stdinPayloads![0] as string) as {
      type: string;
      message: { role: string; content: { type: string }[] };
    };
    expect(payload.type).toBe('user');
    expect(payload.message.role).toBe('user');
    expect(payload.message.content[0]?.type).toBe('text');
  });

  it('inlines image attachments as base64 blocks', () => {
    const adapter = new ClaudeAdapter(cfg);
    const plan = adapter.buildRun({
      session,
      project,
      text: 'what is this?',
      attachments: [{ path: '/tmp/pic.png', name: 'pic.png', mime: 'image/png', size: 4, base64: 'AAAA' }],
      permissionMode: 'default',
    });
    const payload = JSON.parse(plan.stdinPayloads![0] as string) as {
      message: { content: { type: string; source?: { data?: string } }[] };
    };
    const image = payload.message.content.find((b) => b.type === 'image');
    expect(image).toMatchObject({ type: 'image' });
    expect((image as { source?: { data?: string } }).source?.data).toBe('AAAA');
  });

  it('passes non-JSON lines through as raw events', () => {
    const adapter = new ClaudeAdapter(cfg);
    const plan = adapter.buildRun({ session, project, text: 'x', attachments: [], permissionMode: 'default' });
    const events: AgentEvent[] = [];
    plan.parse('plain stdout noise', (event) => events.push(event));
    expect(events).toEqual([{ type: 'raw', line: 'plain stdout noise' }]);
  });
});

describe('codex JSONL parsing (defensive)', () => {
  it('maps agent_message items and usage, tolerating unknown shapes', async () => {
    const { CodexAdapter, createCodexStreamParser } = await import('../src/agents/codex.js');
    const codexCfg: ResolvedAgentConfig = { mode: 'headless', command: 'codex' };
    const adapter = new CodexAdapter(codexCfg);
    const plan = adapter.buildRun({ session, project, text: 'hi', attachments: [], permissionMode: 'default' });
    expect(plan.command).toBe('codex');
    expect(plan.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(plan.args[plan.args.indexOf('-C') + 1]).toBe('/tmp/demo');
    expect(plan.args[plan.args.length - 1]).toBe('hi');
    expect(plan.stdinPayloads).toBeNull();

    const events: AgentEvent[] = [];
    plan.parse(JSON.stringify({ type: 'thread.started', thread_id: 'th_9' }), (e) => events.push(e));
    plan.parse(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: 'All done.' },
      }),
      (e) => events.push(e),
    );
    plan.parse(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
      (e) => events.push(e),
    );
    plan.parse('???unknown???', (e) => events.push(e));

    expect(adapter.externalSessionIdOf?.(JSON.stringify({ type: 'thread.started', thread_id: 'th_9' }))).toBe('th_9');
    expect(adapter.externalSessionIdOf?.('garbage')).toBeUndefined();
    expect(events.some((e) => e.type === 'text-delta' && e.text === 'All done.')).toBe(true);
    expect(events.some((e) => e.type === 'usage' && e.inputTokens === 10)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'raw' });

    const parser = createCodexStreamParser();
    const collected: AgentEvent[] = [];
    parser.parse(JSON.stringify({ msg: { type: 'agent_message', message: 'legacy' } }), (e) => collected.push(e));
    expect(collected.some((e) => e.type === 'text-delta' && e.text === 'legacy')).toBe(true);
  });
});
