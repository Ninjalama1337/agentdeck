/**
 * The active account per agent (after Orca's account switcher): new chats,
 * new terminals and the usage readout of that agent run on it — its env
 * profile (CLAUDE_CONFIG_DIR, CODEX_HOME …) — until the user switches.
 * No entry = the agent's default login. Kept in `active-accounts.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Account } from '@agentdeck/shared';

/** Agents that have account profiles (routes/accounts.ts). */
export const ACCOUNT_AGENTS = ['claude', 'zcode', 'antigravity', 'codex'] as const;
export type AccountAgent = (typeof ACCOUNT_AGENTS)[number];

/** Terminal preset → the agent whose account it runs on. */
export function accountAgentOfPreset(presetId: string | undefined): AccountAgent | undefined {
  return (ACCOUNT_AGENTS as readonly string[]).includes(presetId ?? '') ? (presetId as AccountAgent) : undefined;
}

/** Env var that points each agent at its own login and settings folder. */
export const CONFIG_DIR_ENV: Partial<Record<AccountAgent, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

export class ActiveAccounts {
  private active: Partial<Record<string, string>> = {};
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly lookup: (id: string) => Account | undefined,
  ) {
    this.file = path.join(dataDir, 'active-accounts.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.active[k] = v;
      }
    } catch {
      /* nothing active yet */
    }
  }

  /** Active account per agent; deleted accounts drop out. */
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [agent, id] of Object.entries(this.active)) if (id && this.lookup(id)?.agentId === agent) out[agent] = id;
    return out;
  }

  get(agentId: string): Account | undefined {
    const id = this.active[agentId];
    const account = id ? this.lookup(id) : undefined;
    return account?.agentId === agentId ? account : undefined;
  }

  /** Env of the agent's active account (empty for the default login). */
  envFor(agentId: string): Record<string, string> {
    return this.get(agentId)?.env ?? {};
  }

  set(agentId: string, accountId: string | null): void {
    if (accountId) this.active[agentId] = accountId;
    else delete this.active[agentId];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.active, null, 2));
  }
}
