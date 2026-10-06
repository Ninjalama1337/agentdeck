import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { ClaudeAdapter, claudePermissionSignal } from '../src/agents/claude.js';
import { AgentManager } from '../src/agents/manager.js';
import type { AgentAdapter, RunContext, RunPlan } from '../src/agents/types.js';
import type { AgentService } from '../src/agents/registry.js';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/logging.js';
import { Store } from '../src/state/store.js';

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

const ask = (request: Record<string, unknown>, id = 'req-1') =>
  JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...request } });

function asked(line: string) {
  const signal = claudePermissionSignal(line);
  if (signal?.kind !== 'ask') throw new Error('expected a permission request');
  return signal;
}

const responseOf = (line: string) =>
  (JSON.parse(line) as { response: { request_id: string; response: Record<string, unknown> } }).response;

describe('claudePermissionSignal', () => {
  it('turns a Bash request into a question with the rule an "always" would add', () => {
    const { request, answer } = asked(
      ask({
        tool_name: 'Bash',
        input: { command: 'curl -s https://example.com', description: 'Fetch a page' },
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl -s *' }], behavior: 'allow', destination: 'localSettings' },
        ],
      }),
    );
    expect(request).toMatchObject({ id: 'req-1', tool: 'Bash', always: 'Bash(curl -s *)' });
    expect(request.detail).toContain('curl -s https://example.com');

    const allow = responseOf(answer({ decision: 'allow' }).line);
    expect(allow.request_id).toBe('req-1');
    expect(allow.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'curl -s https://example.com', description: 'Fetch a page' },
    });

    const always = answer({ decision: 'always' });
    expect(responseOf(always.line).response.updatedPermissions).toHaveLength(1);
    expect(always.permissionMode).toBeUndefined();

    expect(responseOf(answer({ decision: 'deny' }).line).response).toEqual({
      behavior: 'deny',
      message: 'The user denied this tool call.',
    });
  });

  it('hands "accept edits" back as the session mode, since it would not outlive the turn', () => {
    const { request, answer } = asked(
      ask({
        tool_name: 'Write',
        input: { file_path: '/p/a.txt', content: 'one\ntwo' },
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      }),
    );
    expect(request.always).toBe('all file edits');
    expect(request.detail).toBe('/p/a.txt\n+ one\n+ two');
    expect(answer({ decision: 'always' }).permissionMode).toBe('acceptEdits');
    expect(answer({ decision: 'allow' }).permissionMode).toBeUndefined();
  });

  it('passes the answers to an AskUserQuestion call', () => {
    const input = {
      questions: [{ question: 'Tea or coffee?', header: 'Drink', options: [{ label: 'Tea' }, { label: 'Coffee', description: 'Bold' }] }],
    };
    const { request, answer } = asked(ask({ tool_name: 'AskUserQuestion', input }));
    expect(request.questions).toEqual([
      { question: 'Tea or coffee?', header: 'Drink', options: [{ label: 'Tea' }, { label: 'Coffee', description: 'Bold' }] },
    ]);
    expect(request.always).toBeUndefined();
    const res = responseOf(answer({ decision: 'allow', answers: { 'Tea or coffee?': 'Coffee' } }).line);
    expect(res.response.updatedInput).toEqual({ ...input, answers: { 'Tea or coffee?': 'Coffee' } });
  });

  it('refuses other control requests at once, sees withdrawn questions and the end of the turn', () => {
    const other = claudePermissionSignal(JSON.stringify({ type: 'control_request', request_id: 'x', request: { subtype: 'hook_callback' } }));
    expect(other?.kind).toBe('reply');
    expect(claudePermissionSignal(JSON.stringify({ type: 'control_cancel_request', request_id: 'req-1' }))).toEqual({
      kind: 'cancel',
      id: 'req-1',
    });
    expect(claudePermissionSignal(JSON.stringify({ type: 'result', subtype: 'success' }))).toEqual({ kind: 'end' });
    expect(claudePermissionSignal(JSON.stringify({ type: 'assistant', message: { content: [] } }))).toBeUndefined();
  });
});

describe('ClaudeAdapter.buildRun', () => {
  const adapter = new ClaudeAdapter({ command: 'claude', mode: 'headless' } as never);
  const ctx = (over: Partial<RunContext>): RunContext =>
    ({ session: {}, project: {}, text: 'hi', attachments: [], permissionMode: 'default', ...over }) as RunContext;

  it('asks the user only for turns from the chat, and never in bypass mode', () => {
    expect(adapter.buildRun(ctx({ interactive: true })).args).toContain('--permission-prompt-tool');
    expect(adapter.buildRun(ctx({ interactive: true })).permissions).toBeDefined();
    expect(adapter.buildRun(ctx({})).args).not.toContain('--permission-prompt-tool');
    expect(adapter.buildRun(ctx({})).permissions).toBeUndefined();
    expect(adapter.buildRun(ctx({ interactive: true, permissionMode: 'bypass' })).permissions).toBeUndefined();
  });
});

/**
 * "Agent" that asks for a permission on stdout, waits for the answer on stdin,
 * reports what it was told and ends its turn.
 */
function askingAgents(): AgentService {
  const source = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    console.log(JSON.stringify({ type: 'text-delta', text: 'Let me check. ' }));
    console.log(JSON.stringify({ ask: { id: 'req-1', tool: 'Bash', summary: 'rm -rf build', always: 'Bash(rm *)', ts: 1 } }));
    rl.once('line', (line) => {
      console.log(JSON.stringify({ type: 'text-delta', text: 'Told: ' + line }));
      console.log(JSON.stringify({ end: true }));
    });
    rl.on('close', () => process.exit(0));`;
  const adapter = {
    id: 'claude',
    label: 'Fake',
    kind: 'cli',
    accentColor: '#fff',
    supportsResume: false,
    detect: async () => ({ available: true }),
    capabilities: () => ({ headless: true }),
    defaultModels: () => [],
    buildRun: (): RunPlan => ({
      command: 'node',
      args: ['-e', source],
      stdinPayloads: [],
      expectStream: true,
      parse: (line, emit) => {
        const parsed = JSON.parse(line) as AgentEvent & { end?: boolean };
        if (!parsed.end) emit(parsed);
      },
      permissions: (line) => {
        const parsed = JSON.parse(line) as { ask?: never; end?: boolean };
        if (parsed.end) return { kind: 'end' };
        if (!parsed.ask) return undefined;
        return {
          kind: 'ask',
          request: parsed.ask,
          answer: (a) => ({ line: a.decision, ...(a.decision === 'always' ? { permissionMode: 'acceptEdits' as const } : {}) }),
        };
      },
    }),
  } as unknown as AgentAdapter;
  return {
    get: () => adapter,
    infoOf: () => ({ id: 'claude', label: 'Fake', available: true, capabilities: { headless: true } }),
  } as unknown as AgentService;
}

describe('AgentManager permission questions', () => {
  let tmp = '';
  let store: Store;
  let project: Project;
  let manager: AgentManager;
  let sent: AgentEvent[];
  let session: Session;

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-perm-'));
    store = new Store(tmp);
    await store.init();
    project = await store.saveProject({ id: 'p_perm', name: 'demo', path: path.join(tmp, 'project'), createdAt: 1, updatedAt: 1 });
  });

  afterAll(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  // Wrapped: an async function returning the promise itself would wait for the run.
  async function begin(): Promise<{ done: Promise<{ ok: boolean; text: string }> }> {
    sent = [];
    const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
    manager = new AgentManager(config, store, askingAgents(), quietLogger, (_id, event) => sent.push(event));
    session = await store.newSession({ projectId: project.id, agentId: 'claude' });
    const done = manager.startTurn({ session, project, text: 'go', attachments: [], source: 'app' });
    for (let i = 0; i < 300 && manager.pendingPermissions(session.id).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { done };
  }

  it('shows the question, hands the answer to the agent and lets the run finish', async () => {
    const { done } = await begin();
    expect(manager.pendingPermissions(session.id)).toMatchObject([{ id: 'req-1', tool: 'Bash' }]);
    expect(manager.draftOf(session.id)?.permissions).toHaveLength(1);
    expect(sent.some((e) => e.type === 'permission-request')).toBe(true);

    expect(await manager.answerPermission(session.id, 'nope', { decision: 'allow' })).toBe(false);
    expect(await manager.answerPermission(session.id, 'req-1', { decision: 'allow' })).toBe(true);
    // A second device answering the same question comes too late.
    expect(await manager.answerPermission(session.id, 'req-1', { decision: 'deny' })).toBe(false);

    const outcome = await done;
    expect(outcome).toMatchObject({ ok: true, text: 'Let me check. Told: allow' });
    expect(sent).toContainEqual({ type: 'permission-resolved', id: 'req-1', decision: 'allow' });
    expect(manager.pendingPermissions(session.id)).toEqual([]);
  });

  it('keeps a mode the answer switched on with the session', async () => {
    const { done } = await begin();
    await manager.answerPermission(session.id, 'req-1', { decision: 'always' });
    await done;
    expect(store.getSession(session.id)?.permissionMode).toBe('acceptEdits');
  });

  it('ends a run that is interrupted while it waits', async () => {
    const { done } = await begin();
    expect(manager.interrupt(session.id, 'stop')).toBe(true);
    const outcome = await done;
    expect(outcome.ok).toBe(true);
    expect(store.getSession(session.id)?.status).toBe('stopped');
  });
});
