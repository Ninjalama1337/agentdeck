import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, Project } from '@agentdeck/shared';
import { AgentManager } from '../src/agents/manager.js';
import { AgentService } from '../src/agents/registry.js';
import { createCustomTextParser } from '../src/agents/custom.js';
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

async function run(promptArg: string, text = 'hello world'): Promise<{ ok: boolean; text: string; available: boolean }> {
  const config = loadConfig({
    env: {
      AGENTDECK_DATA_DIR: tmp,
      AGENTDECK_AGENT_CUSTOM_MODE: 'headless',
      AGENTDECK_AGENT_CUSTOM_COMMAND: `node ${script}`,
    },
    configDir: path.join(tmp, 'none'),
  });
  // promptArg is only settable through the config file.
  const withPromptArg = { ...config, agents: { ...config.agents, custom: { ...config.agents.custom, promptArg } } };
  const agents = new AgentService(withPromptArg, quietLogger);
  const infos = await agents.detectAll();
  const available = infos.find((i) => i.id === 'custom')?.available === true;
  const session = await store.newSession({ projectId: project.id, agentId: 'custom' });
  const manager = new AgentManager(withPromptArg, store, agents, quietLogger, (_id, event: AgentEvent) => void event);
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

  it('keeps fixed flags from the command in front of the prompt', () => {
    const parser = createCustomTextParser();
    const events: AgentEvent[] = [];
    parser.parse('\u001B[31mcolored\u001B[0m answer', (e) => events.push(e));
    expect(events).toEqual([{ type: 'text-delta', text: 'colored answer\n' }]);
  });
});
