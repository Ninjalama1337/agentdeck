import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { AgentManager } from '../src/agents/manager.js';
import type { AgentAdapter, RunPlan } from '../src/agents/types.js';
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

/**
 * "Agent" that prints one JSON event per line; `{"hold": file}` waits for that
 * file. Events between two holds leave in a single write, so they reach the
 * manager as one burst — which makes the bundling deterministic.
 */
function fakeAgents(script: unknown[]): AgentService {
  const source = `
    const fs = require('node:fs');
    const steps = ${JSON.stringify(script)};
    (async () => {
      let burst = '';
      const flush = () => { if (burst) process.stdout.write(burst); burst = ''; };
      for (const step of steps) {
        if (step.hold) {
          flush();
          while (!fs.existsSync(step.hold)) await new Promise((r) => setTimeout(r, 10));
        } else burst += JSON.stringify(step) + '\\n';
      }
      flush();
    })();`;
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
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => emit(JSON.parse(line) as AgentEvent),
    }),
  } as unknown as AgentAdapter;
  return {
    get: () => adapter,
    infoOf: () => ({ id: 'claude', label: 'Fake', available: true, capabilities: { headless: true } }),
  } as unknown as AgentService;
}

type Sent = { event: AgentEvent; run?: string; seq?: number };

let tmp = '';
let store: Store;
let project: Project;

async function setup(script: unknown[]): Promise<{ manager: AgentManager; session: Session; sent: Sent[] }> {
  const sent: Sent[] = [];
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp }, configDir: path.join(tmp, 'none') });
  const manager = new AgentManager(config, store, fakeAgents(script), quietLogger, (_id, event, meta) => {
    sent.push({ event, ...meta });
  });
  const session = await store.newSession({ projectId: project.id, agentId: 'claude' });
  return { manager, session, sent };
}

const start = (manager: AgentManager, session: Session) =>
  manager.startTurn({ session, project, text: 'go', attachments: [], source: 'app' });

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-stream-'));
  store = new Store(tmp);
  await store.init();
  project = await store.saveProject({ id: 'p_stream', name: 'demo', path: path.join(tmp, 'project'), createdAt: 1, updatedAt: 1 });
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('AgentManager live stream', () => {
  it('bundles token deltas, keeps their order around tool events and numbers every run event', async () => {
    const { manager, session, sent } = await setup([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'thinking-delta', text: 'hm' },
      { type: 'text-delta', text: ' wor' },
      { type: 'tool-use', tool: 'Bash', summary: 'ls' },
      { type: 'tool-result', tool: 'Bash', ok: true },
      { type: 'text-delta', text: 'Done.' },
    ]);
    const outcome = await start(manager, session);
    expect(outcome).toMatchObject({ ok: true, text: 'Hello wor\n\nDone.' });

    const run = sent.filter((s) => s.run !== undefined);
    // One id for the whole run, a gapless counter.
    expect(new Set(run.map((s) => s.run)).size).toBe(1);
    expect(run.map((s) => s.seq)).toEqual(run.map((_, i) => i + 1));

    // The seven events arrive in one burst: same-kind neighbours are merged, the order stays.
    expect(run.map((s) => s.event)).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'thinking-delta', text: 'hm' },
      { type: 'text-delta', text: ' wor' },
      { type: 'tool-use', tool: 'Bash', summary: 'ls' },
      { type: 'tool-result', tool: 'Bash', ok: true },
      { type: 'text-delta', text: '\n\nDone.' },
    ]);

    // Nothing of the run trails its final status.
    expect(sent[sent.length - 1]).toEqual({ event: { type: 'status', status: 'idle' } });
    const messages = await store.getMessages(session.id);
    expect(messages[messages.length - 1]).toMatchObject({ role: 'assistant', text: 'Hello wor\n\nDone.', thinking: 'hm' });
  });

  it('hands a client joining mid-run the answer so far, matching the event counter', async () => {
    const gate = path.join(tmp, 'gate');
    const { manager, session, sent } = await setup([
      { type: 'text-delta', text: 'First part. ' },
      { type: 'tool-use', tool: 'Read', summary: 'a.ts' },
      { type: 'tool-result', tool: 'Read', ok: false, summary: 'missing' },
      { type: 'tool-use', tool: 'Bash', summary: 'ls' },
      { type: 'text-delta', text: 'Second' },
      { hold: gate },
      { type: 'text-delta', text: ' part.' },
    ]);
    expect(manager.draftOf(session.id)).toBeUndefined();
    const done = start(manager, session);

    // Wait until everything before the gate was read.
    await expect.poll(() => manager.draftOf(session.id)?.text, { timeout: 5000 }).toBe('First part. \n\nSecond');
    const draft = manager.draftOf(session.id);
    expect(draft).toMatchObject({
      text: 'First part. \n\nSecond',
      tools: [
        { tool: 'Read', state: 'error', summary: 'missing' },
        { tool: 'Bash', state: 'running', summary: 'ls' },
      ],
    });
    // The snapshot holds exactly the events sent so far — nothing is still waiting in a bundle.
    const before = sent.filter((s) => s.run === draft?.run);
    expect(draft?.seq).toBe(before.length);
    expect(before.map((s) => (s.event.type === 'text-delta' ? s.event.text : '')).join('')).toBe('First part. \n\nSecond');

    await fsp.writeFile(gate, '');
    await done;
    const after = sent.filter((s) => s.run === draft?.run && (s.seq ?? 0) > (draft?.seq ?? 0));
    expect(after.map((s) => s.event)).toEqual([{ type: 'text-delta', text: ' part.' }]);
    expect(manager.draftOf(session.id)).toBeUndefined();
  });

  it('starts a new run with a new id', async () => {
    const { manager, session, sent } = await setup([{ type: 'text-delta', text: 'x' }]);
    await start(manager, session);
    await start(manager, session);
    expect(new Set(sent.filter((s) => s.run).map((s) => s.run)).size).toBe(2);
  });

  it('queues a turn posted while a run is active and runs it afterwards', async () => {
    const gate = path.join(tmp, 'gate-queue');
    await fsp.rm(gate, { force: true });
    const { manager, session } = await setup([
      { type: 'text-delta', text: 'first' },
      { hold: gate },
      { type: 'text-delta', text: ' answer' },
    ]);

    expect(manager.submitTurn({ session, project, text: 'one', attachments: [], source: 'app' })).toEqual({ queued: false });
    await expect.poll(() => manager.isActive(session.id), { timeout: 5000 }).toBe(true);

    const second = manager.submitTurn({ session, project, text: 'two', attachments: [], source: 'app' });
    expect(second).toEqual({ queued: true });
    expect(manager.queuedCount(session.id)).toBe(1);
    expect(session.queuedCount).toBe(1);

    await fsp.writeFile(gate, '');
    await expect
      .poll(() => manager.queuedCount(session.id) === 0 && !manager.isActive(session.id), { timeout: 5000 })
      .toBe(true);

    const messages = await store.getMessages(session.id);
    const answers = messages.filter((m) => m.role === 'assistant');
    expect(answers.map((m) => m.text)).toEqual(['first answer', 'first answer']);
  });
});
