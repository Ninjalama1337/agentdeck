import { describe, expect, it } from 'vitest';
import type { AgentEvent, Project, Session } from '@agentdeck/shared';
import { EnhanceError, runEnhance } from '../src/agents/enhance.js';
import type { AgentAdapter, RunPlan } from '../src/agents/types.js';
import type { AgentService } from '../src/agents/registry.js';
import type { Logger } from '../src/logging.js';
import { z } from 'zod';

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

const project: Project = { id: 'p1', name: 'demo', path: '/tmp', createdAt: 0, updatedAt: 0 };

/** Adapter whose "agent" is `cat`: echoes the prompt back as one text delta. */
function fakeAgents(output: string[], opts: { available?: boolean; headless?: boolean } = {}): AgentService {
  const adapter: AgentAdapter = {
    id: 'claude',
    label: 'Fake',
    kind: 'cli',
    accentColor: '#fff',
    supportsResume: false,
    detect: async () => ({ available: true }),
    capabilities: () => ({ headless: opts.headless ?? true }),
    defaultModels: () => [],
    buildRun(ctx): RunPlan {
      void ctx as Session;
      return {
        command: 'node',
        args: ['-e', `console.log(JSON.stringify({text: ${JSON.stringify(output.join(''))}}))`],
        stdinPayloads: null,
        expectStream: true,
        parse(line, emit) {
          try {
            const obj = z.object({ text: z.string() }).parse(JSON.parse(line));
            emit({ type: 'text-delta', text: obj.text } as AgentEvent);
          } catch {
            // non-JSON shell noise
          }
        },
      };
    },
  } as unknown as AgentAdapter;
  return {
    get: () => adapter,
    infoOf: () => ({ id: 'claude', label: 'Fake', available: opts.available ?? true, capabilities: { headless: opts.headless ?? true } }),
  } as unknown as AgentService;
}

describe('runEnhance', () => {
  it('returns the agent answer without touching any store', async () => {
    const text = await runEnhance(
      { agents: fakeAgents(['Rewritten prompt.']), store: { getAccount: () => undefined }, log: quietLogger },
      { project, agentId: 'claude', text: 'mach das ding' },
    );
    expect(text).toBe('Rewritten prompt.');
  });

  it('fails when the agent is unavailable', async () => {
    await expect(
      runEnhance(
        { agents: fakeAgents(['x'], { available: false }), store: { getAccount: () => undefined }, log: quietLogger },
        { project, agentId: 'claude', text: 'hi' },
      ),
    ).rejects.toBeInstanceOf(EnhanceError);
  });

  it('fails when the agent returns no text', async () => {
    await expect(
      runEnhance(
        { agents: fakeAgents(['']), store: { getAccount: () => undefined }, log: quietLogger },
        { project, agentId: 'claude', text: 'hi' },
      ),
    ).rejects.toThrow(/no text/i);
  });
});
