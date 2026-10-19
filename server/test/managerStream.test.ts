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
 * `{"start": file}` / `{"end": file}` append a marker, so a test can see when a
 * process actually ran.
 */
function fakeAgents(script: unknown[]): AgentService {
  const source = `
    const fs = require('node:fs');
    const steps = ${JSON.stringify(script)};
    (async () => {
      let burst = '';
      const flush = () => { if (burst) process.stdout.write(burst); burst = ''; };
      for (const step of steps) {
        if (step.start) {
          flush();
          fs.appendFileSync(step.start, 'start\\n');
        } else if (step.end) {
          flush();
          fs.appendFileSync(step.end, 'end\\n');
        } else if (step.hold) {
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

async function readLines(file: string): Promise<string[]> {
  try {
    return (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

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

  it('keeps the plan checklist on the finished assistant message', async () => {
    const items = [
      { text: 'Read the code', status: 'completed' as const },
      { text: 'Write the fix', status: 'in_progress' as const },
    ];
    const { manager, session } = await setup([
      { type: 'plan', items },
      { type: 'text-delta', text: 'All set.' },
    ]);
    const outcome = await start(manager, session);
    expect(outcome.ok).toBe(true);

    const messages = await store.getMessages(session.id);
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'assistant',
      text: 'All set.',
      plan: items,
    });
  });

  it('does not spawn a run canceled while it still held the starting reservation', async () => {
    const log = path.join(tmp, `canceled-${Date.now()}.log`);
    await fsp.rm(log, { force: true });
    const { manager, session } = await setup([{ start: log }, { type: 'text-delta', text: 'x' }]);

    // startTurn claims `starting` synchronously, then awaits persistence.
    const started = start(manager, session);
    expect(manager.interrupt(session.id, 'Session deleted')).toBe(true);
    const outcome = await started;
    expect(outcome).toMatchObject({ ok: false });

    // Give a leaked child time to show up.
    await new Promise((r) => setTimeout(r, 100));
    expect(await readLines(log)).toEqual([]);
    expect(manager.isActive(session.id)).toBe(false);
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

    expect(await manager.submitTurn({ session, project, text: 'one', attachments: [], source: 'app' })).toEqual({ queued: false });
    await expect.poll(() => manager.isActive(session.id), { timeout: 5000 }).toBe(true);

    const second = await manager.submitTurn({ session, project, text: 'two', attachments: [], source: 'app' });
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

  it('reserves the session before the first await so two simultaneous submits run one at a time', async () => {
    const run = Date.now();
    const gate = path.join(tmp, `gate-race-${run}`);
    const log = path.join(tmp, `race-${run}.log`);
    await fsp.rm(gate, { force: true });
    await fsp.rm(log, { force: true });
    const { manager, session } = await setup([{ start: log }, { hold: gate }, { end: log }]);

    // Same tick: the second submit must queue behind the first, not spawn its own process.
    const first = manager.submitTurn({ session, project, text: 'one', attachments: [], source: 'app' });
    const second = manager.submitTurn({ session, project, text: 'two', attachments: [], source: 'app' });
    expect(await first).toEqual({ queued: false });
    expect(await second).toEqual({ queued: true });

    await expect.poll(async () => (await readLines(log)).filter((l) => l === 'start').length, { timeout: 5000 }).toBe(1);
    // Give a buggy second spawn time to show up while the first still holds.
    await new Promise((r) => setTimeout(r, 100));
    expect((await readLines(log)).filter((l) => l === 'start')).toHaveLength(1);
    expect((await readLines(log)).filter((l) => l === 'end')).toHaveLength(0);

    await fsp.writeFile(gate, '');
    await expect.poll(async () => (await readLines(log)).filter((l) => l === 'start').length, { timeout: 5000 }).toBe(2);
    await expect
      .poll(() => manager.queuedCount(session.id) === 0 && !manager.isActive(session.id), { timeout: 5000 })
      .toBe(true);

    // The first process ended before the second one started.
    expect((await readLines(log)).filter((l) => l === 'start' || l === 'end')).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
  });

  it('refuses a second direct startTurn while the first is still spawning', async () => {
    const run = Date.now();
    const gate = path.join(tmp, `gate-direct-${run}`);
    const log = path.join(tmp, `direct-${run}.log`);
    await fsp.rm(gate, { force: true });
    await fsp.rm(log, { force: true });
    const { manager, session } = await setup([{ start: log }, { hold: gate }, { end: log }]);

    const first = manager.startTurn({ session, project, text: 'one', attachments: [], source: 'app' });
    const second = await manager.startTurn({ session, project, text: 'two', attachments: [], source: 'app' });
    expect(second).toMatchObject({ ok: false, error: /already active/ });
    expect(manager.queuedCount(session.id)).toBe(0);

    await fsp.writeFile(gate, '');
    await first;
    expect((await readLines(log)).filter((l) => l === 'start')).toHaveLength(1);
  });
});
