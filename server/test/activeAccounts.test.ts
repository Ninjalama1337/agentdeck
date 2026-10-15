import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@agentdeck/shared';
import { accountAgentOfPreset, ActiveAccounts } from '../src/accounts/active.js';
import { UsageCollector } from '../src/usage/collector.js';

const acc = (id: string, agentId: Account['agentId'], env: Record<string, string> = {}): Account => ({ id, name: id, agentId, env, createdAt: 0 });

describe('ActiveAccounts', () => {
  it('remembers the active account per agent and hands out its env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-acc-'));
    const accounts = new Map([
      ['a1', acc('a1', 'claude', { CLAUDE_CONFIG_DIR: '/x' })],
      ['c1', acc('c1', 'codex', { CODEX_HOME: '/y' })],
    ]);
    const lookup = (id: string) => accounts.get(id);
    const active = new ActiveAccounts(dir, lookup);
    expect(active.envFor('claude')).toEqual({});
    active.set('claude', 'a1');
    active.set('codex', 'c1');
    expect(new ActiveAccounts(dir, lookup).envFor('claude')).toEqual({ CLAUDE_CONFIG_DIR: '/x' });
    // A deleted account or one of another agent no longer counts.
    accounts.delete('c1');
    expect(active.all()).toEqual({ claude: 'a1' });
    active.set('claude', null);
    expect(active.get('claude')).toBeUndefined();
  });

  it('maps presets to account agents', () => {
    expect(accountAgentOfPreset('claude')).toBe('claude');
    expect(accountAgentOfPreset('shell')).toBeUndefined();
  });
});

describe('UsageCollector with an active account', () => {
  it('reads usage under the account env', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const collector = new UsageCollector({
      agents: { infoOf: () => undefined } as never,
      isAvailable: (id: string) => id === 'claude',
      spawn: async (_cmd, _args, opts) => {
        seen.push(opts.env);
        return { stdout: '', stderr: '', exitCode: 1 };
      },
      envFor: (id) => (id === 'claude' ? { CLAUDE_CONFIG_DIR: '/acc' } : {}),
    } as never);
    await collector.collect();
    expect(seen).toContainEqual({ CLAUDE_CONFIG_DIR: '/acc' });
  });
});
