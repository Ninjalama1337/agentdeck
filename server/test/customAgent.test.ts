import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, Project } from '@agentdeck/shared';
import { AgentManager } from '../src/agents/manager.js';
import { AgentService } from '../src/agents/registry.js';
import { CustomCliAdapter, createCustomTextParser } from '../src/agents/custom.js';
import type { RunContext } from '../src/agents/types.js';
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

/** A stand-in for "any CLI agent": prints its prompt, or reads it from stdin. */
const FAKE_CLI = `
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-cli 1.2.3\\n'); process.exit(0); }
if (args.length === 0) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (data += d)).on('end', () => process.stdout.write('stdin: ' + data.trim() + '\\n'));
} else {
  process.stdout.write('prompt: ' + args.join(' ') + '\\n');
}
`;

let tmp = '';
let store: Store;
let project: Project;
let script = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-custom-'));
  store = new Store(tmp);
  await store.init();
  project = await store.saveProject({ id: 'p_custom', name: 'demo', path: path.join(tmp, 'project'), createdAt: 1, updatedAt: 1 });
  script = path.join(tmp, 'fake-cli.cjs');
  await fsp.writeFile(script, FAKE_CLI, 'utf8');
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function run(
  promptArg: string,
  text = 'hello world',
  extra: { modelArg?: string; model?: string } = {},
): Promise<{ ok: boolean; text: string; available: boolean }> {
  const config = loadConfig({
    env: {
      AGENTDECK_DATA_DIR: tmp,
      AGENTDECK_AGENT_CUSTOM_MODE: 'headless',
      AGENTDECK_AGENT_CUSTOM_COMMAND: `node ${script}`,
    },
    configDir: path.join(tmp, 'none'),
  });
  // promptArg/modelArg are only settable through the config file.
  const withArgs = {
    ...config,
    agents: {
      ...config.agents,
      custom: { ...config.agents.custom, promptArg, ...(extra.modelArg !== undefined ? { modelArg: extra.modelArg } : {}) },
    },
  };
  const agents = new AgentService(withArgs, quietLogger);
  const infos = await agents.detectAll();
  const available = infos.find((i) => i.id === 'custom')?.available === true;
  const session = await store.newSession({ projectId: project.id, agentId: 'custom', model: extra.model });
  const manager = new AgentManager(withArgs, store, agents, quietLogger, (_id, event: AgentEvent) => void event);
  const outcome = await manager.startTurn({ session, project, text, attachments: [], source: 'app' });
  return { ok: outcome.ok, text: outcome.text, available };
}

describe('custom CLI agent', () => {
  it('detects the configured command and answers a turn with the prompt as an argument', async () => {
    const res = await run('{prompt}');
    expect(res.available).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.text.trim()).toBe('prompt: hello world');
  });

  it('pipes the prompt on stdin when promptArg is empty', async () => {
    const res = await run('', 'via stdin');
    expect(res.ok).toBe(true);
    expect(res.text.trim()).toBe('stdin: via stdin');
  });

  it('substitutes an embedded {prompt} without splitting the argument', () => {
    const adapter = new CustomCliAdapter({ mode: 'headless', command: 'fake --flag', promptArg: '--message={prompt}' });
    const plan = adapter.buildRun({ text: 'hello world', attachments: [] } as RunContext);
    expect(plan.args).toEqual(['--flag', '--message=hello world']);
    expect(plan.stdinPayloads).toBeNull();
  });

  it('keeps the prompt on stdin when promptArg is only whitespace', () => {
    const adapter = new CustomCliAdapter({ mode: 'headless', command: 'fake --flag', promptArg: '   ' });
    const plan = adapter.buildRun({ text: 'hello world', attachments: [] } as RunContext);
    expect(plan.args).toEqual(['--flag']);
    expect(plan.stdinPayloads).toEqual(['hello world']);
  });

  it('keeps fixed flags from the command in front of the prompt', () => {
    const parser = createCustomTextParser();
    const events: AgentEvent[] = [];
    parser.parse('\u001B[31mcolored\u001B[0m answer', (e) => events.push(e));
    expect(events).toEqual([{ type: 'text-delta', text: 'colored answer\n' }]);
  });

  it('substitutes an embedded {model} without splitting the argument', () => {
    const adapter = new CustomCliAdapter({
      mode: 'headless',
      command: 'fake --flag',
      promptArg: '--message={prompt}',
      modelArg: '--model={model}',
    });
    const plan = adapter.buildRun({ text: 'hello world', attachments: [], model: 'gpt-5' } as RunContext);
    expect(plan.args).toEqual(['--flag', '--model=gpt-5', '--message=hello world']);
    expect(plan.stdinPayloads).toBeNull();
  });

  it('turns a standalone {model} token into model and value', () => {
    const adapter = new CustomCliAdapter({
      mode: 'headless',
      command: 'fake',
      promptArg: '{prompt}',
      modelArg: '--model {model}',
    });
    const plan = adapter.buildRun({ text: 'hello world', attachments: [], model: 'claude-opus-4' } as RunContext);
    expect(plan.args).toEqual(['--model', 'claude-opus-4', 'hello world']);
  });

  it('appends the model when modelArg is a flag without {model}', () => {
    const adapter = new CustomCliAdapter({
      mode: 'headless',
      command: 'fake',
      promptArg: '{prompt}',
      modelArg: '--model',
    });
    const plan = adapter.buildRun({ text: 'hello world', attachments: [], model: 'gpt-5' } as RunContext);
    expect(plan.args).toEqual(['--model', 'gpt-5', 'hello world']);
  });

  it('ignores the model when modelArg is absent or empty', () => {
    const withoutArg = new CustomCliAdapter({ mode: 'headless', command: 'fake', promptArg: '{prompt}' });
    const emptyArg = new CustomCliAdapter({ mode: 'headless', command: 'fake', promptArg: '{prompt}', modelArg: '' });
    for (const adapter of [withoutArg, emptyArg]) {
      const plan = adapter.buildRun({ text: 'hello world', attachments: [], model: 'gpt-5' } as RunContext);
      expect(plan.args).toEqual(['hello world']);
    }
  });

  it('passes the session model to the CLI through modelArg', async () => {
    const res = await run('{prompt}', 'hello world', { modelArg: '--model={model}', model: 'gpt-5' });
    expect(res.ok).toBe(true);
    expect(res.text.trim()).toBe('prompt: --model=gpt-5 hello world');
  });
});
