import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerCliInfo } from '@agentdeck/shared';
import { collectInfo } from '../src/cli/info.js';
import { renderUnit } from '../src/cli/unit.js';

const run = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-info-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AGENTDECK_CONFIG: path.join(tmp, 'config.json'),
  AGENTDECK_DATA_DIR: path.join(tmp, 'data'),
  ...extra,
});

describe('collectInfo', () => {
  it('resolves paths, address and version the way the server does', () => {
    const info = collectInfo({ env: env({ AGENTDECK_PORT: '9001', AGENTDECK_HOST: '127.0.0.1' }), version: '1.2.3', packaged: true, webDist: '/x/web/dist' });
    expect(info).toEqual<ServerCliInfo>({
      version: '1.2.3',
      packaged: true,
      dataDir: path.join(tmp, 'data'),
      configPath: path.join(tmp, 'config.json'),
      host: '127.0.0.1',
      port: 9001,
      pairingCodeFile: path.join(tmp, 'data', 'pairing-code.txt'),
      pidFile: path.join(tmp, 'data', 'server.pid'),
      webDist: '/x/web/dist',
    });
  });

  it('reads host and port from config.json when env does not set them', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 9555, host: '127.0.0.1' }));
    expect(collectInfo({ env: env(), webDist: undefined })).toMatchObject({ port: 9555, host: '127.0.0.1' });
  });

  it('omits webDist when the web app is not built', () => {
    expect('webDist' in collectInfo({ env: env(), webDist: undefined })).toBe(false);
  });

  it('takes port and host from an installed service unit, unless the caller sets them', () => {
    const unitPath = path.join(tmp, 'agentdeck.service');
    fs.writeFileSync(unitPath, renderUnit({ execStart: '/r/current/bin/agentdeck-server', lan: true, port: 9100 }));
    expect(collectInfo({ env: env(), unitPath, webDist: undefined })).toMatchObject({ port: 9100, host: '0.0.0.0' });
    expect(collectInfo({ env: env({ AGENTDECK_PORT: '9200' }), unitPath, webDist: undefined })).toMatchObject({ port: 9200 });
  });

  it('ignores a unit it did not write', () => {
    const unitPath = path.join(tmp, 'agentdeck.service');
    fs.writeFileSync(unitPath, '[Service]\nEnvironment=AGENTDECK_PORT=1111\n');
    expect(collectInfo({ env: env(), unitPath, webDist: undefined }).port).toBe(8787);
  });

  it('fails on an unreadable config file', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{nope');
    expect(() => collectInfo({ env: env() })).toThrow(/Invalid AgentDeck config/);
  });
});

describe('agentdeck-server as a process', () => {
  const cli = (args: string[], extra: Record<string, string> = {}) =>
    run(process.execPath, ['--import', 'tsx', path.join(SERVER_DIR, 'src/cli.ts'), ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env(extra), HOME: tmp, XDG_RUNTIME_DIR: path.join(tmp, 'run') },
      timeout: 30_000,
    });

  it('info --json prints exactly one JSON document on stdout', async () => {
    const { stdout, stderr } = await cli(['info', '--json'], { AGENTDECK_PORT: '9777' });
    const info = JSON.parse(stdout) as ServerCliInfo;
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(info).toMatchObject({ port: 9777, packaged: false, dataDir: path.join(tmp, 'data') });
    expect(stderr).toBe('');
  });

  it('service status --json works without systemd', async () => {
    const { stdout } = await cli(['service', 'status', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ installed: false, active: false, unitPath: path.join(tmp, '.config/systemd/user/agentdeck.service') });
  });

  it('a failing command exits non-zero with the message on stderr and JSON on stdout', async () => {
    await expect(cli(['service', 'install', '--json'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('not a packaged server'),
      stdout: expect.stringMatching(/^\{"error":".*not a packaged server.*"\}\n$/),
    });
  });

  it('a usage error exits with 2', async () => {
    await expect(cli(['nonsense'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown command') });
  });
});
