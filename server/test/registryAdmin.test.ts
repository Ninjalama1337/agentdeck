import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '@agentdeck/shared';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { AgentService } from '../src/agents/registry.js';

/**
 * AgentInfo.admin + AgentService.redetect — the hooks the AdminJobRunner
 * needs: every agent advertises its admin capabilities, and re-detection
 * after an update/install job refreshes the cached info and fires the
 * agent:update handlers. Detection here uses `echo` as a stand-in command —
 * real binaries are not required.
 */
function service() {
  const config = loadConfig({
    env: {
      AGENTDECK_DATA_DIR: path.join(os.tmpdir(), `agentdeck-registry-${Date.now()}`),
      AGENTDECK_TUNNEL: 'off',
      AGENTDECK_AGENT_CLAUDE_COMMAND: 'echo',
      AGENTDECK_AGENT_ZCODE_COMMAND: 'echo',
      AGENTDECK_AGENT_ANTIGRAVITY_COMMAND: 'echo',
      AGENTDECK_AGENT_CODEX_COMMAND: 'echo',
    },
    configDir: path.join(os.tmpdir(), 'agentdeck-registry-none'),
  });
  return new AgentService(config, createLogger('error'));
}

describe('AgentService admin integration', () => {
  it('lists admin capabilities on every AgentInfo', async () => {
    const agents = service();
    await agents.detectAll();
    for (const info of agents.info()) {
      expect(info.admin).toBeDefined();
      expect(info.admin).toHaveLength(3);
      expect(info.admin!.map((c) => c.kind)).toEqual(['update', 'install', 'login']);
    }
    expect(agents.infoOf('claude')!.admin!.find((c) => c.kind === 'login')?.unavailableReason)
      .toBeUndefined();
    expect(agents.infoOf('claude')!.admin!.find((c) => c.kind === 'login')?.label)
      .toContain('setup-token');
    expect(agents.infoOf('zcode')!.admin!.find((c) => c.kind === 'update')?.label)
      .toBe('scripts/update-zcode.sh');
  });

  it('redetect refreshes the cached info and fires the update handlers', async () => {
    const agents = service();
    await agents.detectAll();
    const seen: AgentInfo[] = [];
    agents.onInfo((info) => seen.push(info));

    const info = await agents.redetect('claude');
    expect(info?.id).toBe('claude');
    expect(info?.admin).toHaveLength(3);
    expect(agents.infoOf('claude')).toBe(info); // cache updated
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('claude');

    expect(await agents.redetect('bogus' as never)).toBeUndefined();
  });
});
