import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { AgentManager } from '../src/agents/manager.js';
import type { AgentAdapter, PermissionSignal, RunPlan } from '../src/agents/types.js';
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
 * "Agent" that walks a script: JSON events go to stdout, `ask` prints the line
 * the permission handler recognizes, `hold` waits for a file.
 */
function fakeAgents(script: unknown[]): AgentService {
  const source = `
    const fs = require('node:fs');
    const steps = ${JSON.stringify(script)};
    (async () => {
      for (const step of steps) {
        if (step.ask) { process.stdout.write(JSON.stringify({ ask: 1 }) + '\\n'); continue; }
        if (step.hold) {
          while (!fs.existsSync(step.hold)) await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        process.stdout.write(JSON.stringify(step) + '\\n');
      }
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
      stdinPayloads: [],
      expectStream: true,
      permissions: (line: string): PermissionSignal | undefined => {
        let obj: { ask?: number } | undefined;
        try {
          obj = JSON.parse(line) as { ask?: number };
        } catch {
          return undefined;
        }
        if (!obj?.ask) return undefined;
        return {
          kind: 'ask',
          request: { id: 'req-1', tool: 'Bash', summary: 'rm -rf build', ts: 0 },
          answer: () => ({ line: JSON.stringify({ ok: true }) }),
        };
      },
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
let seqNo = 0;

async function setup(
  script: unknown[],
  env: Record<string, string> = {},
): Promise<{ manager: AgentManager; session: Session; sent: Sent[] }> {
  const sent: Sent[] = [];
  const config = loadConfig({
    env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_STALL_WARN_MS: '120', AGENTDECK_STALL_ABORT_MS: '500', ...env },
    configDir: path.join(tmp, 'none'),
  });
  const manager = new AgentManager(config, store, fakeAgents(script), quietLogger, (_id, event, meta) => {
    sent.push({ event, ...meta });
  });
  seqNo += 1;
  const session = await store.newSession({ projectId: project.id, agentId: 'claude', title: `s${seqNo}` });
  return { manager, session, sent };
}

const start = (manager: AgentManager, session: Session) =>
  manager.startTurn({ session, project, text: 'go', attachments: [], source: 'app' });

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-watchdog-'));
  store = new Store(tmp);
  await store.init();
  project = await store.saveProject({ id: 'p_wd', name: 'demo', path: path.join(tmp, 'project'), createdAt: 1, updatedAt: 1 });
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('AgentManager stall watchdog', () => {
  it('notes a silent run and stops it instead of hanging forever', async () => {
    const never = path.join(tmp, `never-${Date.now()}`);
    const { manager, session, sent } = await setup([{ hold: never }]);
    const outcome = await start(manager, session);

    const notices = sent.filter((s) => s.event.type === 'raw' && s.event.line.startsWith('[agentdeck] ')).map((s) => (s.event as { line: string }).line);
    expect(notices.some((n) => /No output for/.test(n))).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(session.status).toBe('error');
    expect(session.lastError).toMatch(/looked stuck/);
    expect(manager.isActive(session.id)).toBe(false);
  });

  it('retires a question the run can no longer answer', async () => {
    const { manager, session, sent } = await setup([{ ask: true }]);
    const outcome = await start(manager, session);

    const kinds = sent.map((s) => s.event.type);
    expect(kinds).toContain('permission-request');
    expect(kinds).toContain('permission-resolved');
    expect(outcome.ok).toBe(false);
    expect(session.status).toBe('error');
    expect(session.lastError).toMatch(/waiting for your answer/);
    expect(manager.pendingPermissions(session.id)).toEqual([]);
  });

  it('does not retire a question the user answered in time', async () => {
    const gate = path.join(tmp, `gate-${Date.now()}`);
    const { manager, session, sent } = await setup([{ ask: true }, { hold: gate }, { type: 'text-delta', text: 'done' }]);
    const done = start(manager, session);

    await expect.poll(() => manager.pendingPermissions(session.id).length, { timeout: 5000 }).toBe(1);
    await expect(manager.answerPermission(session.id, 'req-1', { decision: 'allow' })).resolves.toBe(true);
    await fsp.writeFile(gate, '');
    const outcome = await done;

    expect(outcome).toMatchObject({ ok: true, text: 'done' });
    expect(session.status).toBe('idle');
    expect(sent.some((s) => s.event.type === 'permission-resolved')).toBe(true);
  });
});
