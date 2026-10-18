import { describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { createCodexStreamParser } from '../src/agents/codex.js';
import { createOpenCodeStreamParser } from '../src/agents/opencode.js';
import { isPlanTool, planItemsOf } from '../src/agents/plan.js';
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

describe('planItemsOf', () => {
  it('reads a Claude TodoWrite input', () => {
    expect(
      planItemsOf({
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
          { content: 'Write the fix', status: 'in_progress' },
          { content: 'Run the tests', status: 'pending' },
        ],
      }),
    ).toEqual([
      { text: 'Read the code', status: 'completed' },
      { text: 'Write the fix', status: 'in_progress' },
      { text: 'Run the tests', status: 'pending' },
    ]);
  });

  it('reads a Codex update_plan shape and boolean completion', () => {
    expect(
      planItemsOf({
        plan: [
          { step: 'Look around', status: 'completed' },
          { step: 'Patch it', status: 'in_progress' },
        ],
      }),
    ).toEqual([
      { text: 'Look around', status: 'completed' },
      { text: 'Patch it', status: 'in_progress' },
    ]);
    // Some Codex versions only carry `completed`.
    expect(planItemsOf({ steps: [{ text: 'One', completed: true }, { text: 'Two', completed: false }] })).toEqual([
      { text: 'One', status: 'completed' },
      { text: 'Two', status: 'pending' },
    ]);
  });

  it('accepts a bare array, drops entries without text and caps overlong text', () => {
    expect(planItemsOf([{ content: 'a' }, { status: 'completed' }, { content: 'x'.repeat(400) }])).toEqual([
      { text: 'a', status: 'pending' },
      { text: `${'x'.repeat(300)}…`, status: 'pending' },
    ]);
  });

  it('is undefined for payloads without a checklist', () => {
    expect(planItemsOf(undefined)).toBeUndefined();
    expect(planItemsOf({ command: 'ls' })).toBeUndefined();
    expect(planItemsOf({ todos: [] })).toBeUndefined();
  });
});

describe('isPlanTool', () => {
  it('knows the names each CLI uses', () => {
    expect(isPlanTool('TodoWrite')).toBe(true);
    expect(isPlanTool('todowrite')).toBe(true);
    expect(isPlanTool('update_plan')).toBe(true);
    expect(isPlanTool('Read')).toBe(false);
    expect(isPlanTool(undefined)).toBe(false);
  });
});

describe('Claude TodoWrite becomes a checklist', () => {
  const events: AgentEvent[] = [];
  const adapter = new ClaudeAdapter(cfg);
  const plan = adapter.buildRun({ session, project, text: 'go', attachments: [], permissionMode: 'default' });

  plan.parse(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_todo',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Step one', status: 'in_progress' }] },
          },
        ],
      },
    }),
    (e) => events.push(e),
  );
  // The result of the plan call must not show up as a stray tool row.
  plan.parse(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_todo', content: 'Todos updated' }] },
    }),
    (e) => events.push(e),
  );

  it('emits the plan and suppresses the tool call/result', () => {
    expect(events).toEqual([{ type: 'plan', items: [{ text: 'Step one', status: 'in_progress' }] }]);
  });
});

describe('Codex plan items become a checklist', () => {
  it('parses a plan item instead of printing it as answer text', () => {
    const parser = createCodexStreamParser();
    const events: AgentEvent[] = [];
    parser.parse(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'plan', text: 'ignored', steps: [{ step: 'A', status: 'completed' }] },
      }),
      (e) => events.push(e),
    );
    expect(events).toEqual([{ type: 'plan', items: [{ text: 'A', status: 'completed' }] }]);
  });
});

describe('OpenCode todowrite becomes a checklist', () => {
  it('emits the plan and no tool row', () => {
    const parser = createOpenCodeStreamParser();
    const events: AgentEvent[] = [];
    parser.parse(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool_use',
          callID: 'c1',
          tool: 'todowrite',
          state: { status: 'completed', input: { todos: [{ content: 'Ship it', status: 'pending' }] } },
        },
      }),
      (e) => events.push(e),
    );
    expect(events).toEqual([{ type: 'plan', items: [{ text: 'Ship it', status: 'pending' }] }]);
  });
});
