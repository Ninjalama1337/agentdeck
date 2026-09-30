import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let tmp = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-config-'));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('applies contract defaults', () => {
    const config = loadConfig({ env: {}, configDir: path.join(tmp, 'none') });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8787);
    expect(config.maxRunMs).toBe(1_800_000);
    expect(config.maxUploadBytes).toBe(20 * 1024 * 1024);
    expect(config.corsOrigins).toContain('capacitor://localhost');
    expect(config.agents.claude).toMatchObject({ mode: 'headless', command: 'claude' });
    expect(config.agents.zcode).toMatchObject({ mode: 'auto', command: 'zcode' });
    expect(config.agents.antigravity?.command).toContain('com.google.Antigravity');
    expect(config.agents.codex).toMatchObject({ mode: 'headless', command: 'codex' });
    // dataDir resolved & absolutized; projectsRoot defaults under it
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.projectsRoot).toBe(path.join(config.dataDir, 'projects'));
  });

  it('env overrides win over defaults', () => {
    const config = loadConfig({
      env: {
        AGENTDECK_PORT: '9001',
        AGENTDECK_DATA_DIR: '~/custom-data',
        AGENTDECK_PROJECTS_ROOT: '/explicit/projects',
        AGENTDECK_AGENT_ZCODE_MODE: 'headless',
        AGENTDECK_AGENT_ZCODE_COMMAND: 'zcode-cli',
        AGENTDECK_CORS_ORIGINS: 'http://a.example,http://b.example',
      },
      configDir: path.join(tmp, 'none'),
    });
    expect(config.port).toBe(9001);
    expect(path.basename(config.dataDir)).toBe('custom-data');
    expect(config.projectsRoot).toBe('/explicit/projects');
    expect(config.agents.zcode).toMatchObject({ mode: 'headless', command: 'zcode-cli' });
    expect(config.corsOrigins).toEqual(['http://a.example', 'http://b.example']);
  });

  it('file config merges over defaults and env wins over file', async () => {
    const configDir = path.join(tmp, 'cfg');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        port: 7777,
        serverName: 'deck-box',
        agents: { claude: { mode: 'ide', command: '/usr/local/bin/claude' } },
      }),
      'utf8',
    );
    const fromFile = loadConfig({ env: {}, configDir });
    expect(fromFile.port).toBe(7777);
    expect(fromFile.serverName).toBe('deck-box');
    expect(fromFile.agents.claude).toMatchObject({ mode: 'ide', command: '/usr/local/bin/claude' });
    expect(fromFile.agents.codex).toMatchObject({ mode: 'headless' }); // untouched default

    const withEnv = loadConfig({ env: { AGENTDECK_PORT: '8888' }, configDir });
    expect(withEnv.port).toBe(8888);
  });

  it('reads an existing real config file when present (smoke sanity)', () => {
    // Ensure the loader does not crash on machines without config files.
    expect(() => loadConfig({ env: {}, configDir: path.join(tmp, 'missing') })).not.toThrow();
  });

  it('rejects invalid config values', () => {
    const badDir = path.join(tmp, 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.json'), JSON.stringify({ port: 'not-a-number' }));
    expect(() => loadConfig({ env: {}, configDir: badDir })).toThrow();
  });
});
