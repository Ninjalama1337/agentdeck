import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliError,
  createCli,
  parseJsonOutput,
  parseServerInfo,
  parseServiceStatus,
  resolveServerBin,
  ServerBinNotFoundError,
  type Exec,
} from '../src/core/cli';
import { nodeExec } from '../src/core/exec';

const INFO = {
  version: '1.2.3',
  packaged: true,
  dataDir: '/data',
  configPath: '/cfg/config.json',
  host: '127.0.0.1',
  port: 4317,
  pairingCodeFile: '/data/pairing-code.txt',
  pidFile: '/data/server.pid',
  webDist: '/app/web/dist',
};

function execReturning(stdout: string, code = 0, stderr = ''): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (_file, args) => {
      calls.push(args);
      return { code, stdout, stderr };
    },
  };
}

describe('parseServerInfo', () => {
  it('accepts the contract shape', () => {
    expect(parseServerInfo(INFO)).toEqual(INFO);
  });

  it('fills the optional fields and rejects garbage', () => {
    const minimal = parseServerInfo({ ...INFO, configPath: undefined, host: undefined, webDist: undefined, packaged: undefined });
    expect(minimal.host).toBe('127.0.0.1');
    expect(minimal.packaged).toBe(false);
    expect(minimal.webDist).toBeUndefined();
    expect(() => parseServerInfo({ ...INFO, port: 'x' })).toThrow(CliError);
    expect(() => parseServerInfo({ ...INFO, port: 70000 })).toThrow(/port/);
    expect(() => parseServerInfo({ ...INFO, dataDir: '' })).toThrow(/dataDir/);
    expect(() => parseServerInfo([])).toThrow(CliError);
    expect(() => parseServerInfo(null)).toThrow(CliError);
  });
});

describe('parseServiceStatus', () => {
  it('reads flags and optional fields', () => {
    expect(
      parseServiceStatus({ systemd: true, installed: true, managed: true, enabled: true, active: true, mainPid: 42, unitPath: '/u', lan: false, runtimeVersion: '1.2.3' }),
    ).toEqual({ systemd: true, installed: true, managed: true, enabled: true, active: true, mainPid: 42, unitPath: '/u', lan: false, runtimeVersion: '1.2.3' });
  });

  it('treats missing flags as false', () => {
    expect(parseServiceStatus({})).toEqual({ systemd: false, installed: false, managed: false, enabled: false, active: false, unitPath: '', lan: false });
  });
});

describe('parseJsonOutput', () => {
  it('parses plain JSON and tolerates noise around the object', () => {
    expect(parseJsonOutput('{"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonOutput('(node:1) Warning: x\n{"a":1}\n')).toEqual({ a: 1 });
  });
  it('throws a CliError on anything else', () => {
    expect(() => parseJsonOutput('')).toThrow(CliError);
    expect(() => parseJsonOutput('nope')).toThrow(/Unexpected output/);
  });
});

describe('createCli', () => {
  it('runs info and service status with --json', async () => {
    const info = execReturning(JSON.stringify(INFO));
    expect(await createCli({ bin: '/bin/x', exec: info.exec }).info()).toEqual(INFO);
    expect(info.calls).toEqual([['info', '--json']]);

    const status = execReturning(JSON.stringify({ systemd: true }));
    expect((await createCli({ bin: '/bin/x', exec: status.exec }).serviceStatus()).systemd).toBe(true);
    expect(status.calls).toEqual([['service', 'status', '--json']]);
  });

  it('builds the install command line', async () => {
    const { exec, calls } = execReturning('');
    const cli = createCli({ bin: '/bin/x', exec });
    await cli.serviceInstall();
    await cli.serviceInstall({ lan: true });
    await cli.serviceInstall({ lan: true, port: 4400, noStart: true });
    await cli.serviceUninstall();
    await cli.serviceStart();
    await cli.serviceStop();
    await cli.serviceRestart();
    expect(calls).toEqual([
      ['service', 'install', '--json'],
      ['service', 'install', '--lan', '--json'],
      ['service', 'install', '--lan', '--port', '4400', '--no-start', '--json'],
      ['service', 'uninstall', '--json'],
      ['service', 'start', '--json'],
      ['service', 'stop', '--json'],
      ['service', 'restart', '--json'],
    ]);
  });

  it('turns a non-zero exit into a CliError carrying the CLI message', async () => {
    const { exec } = execReturning('', 1, 'warn\nA unit named agentdeck.service exists — use --force\n');
    const err = await createCli({ bin: '/bin/x', exec }).serviceInstall().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('use --force');
    expect((err as CliError).exitCode).toBe(1);
  });

  it('prefers the {"error": …} document of a --json call over stderr noise', async () => {
    const { exec } = execReturning('{"error":"An AgentDeck server is already running outside the service (pid 7)."}', 1, 'copying runtime…\nAn AgentDeck server is already running\n');
    const err = await createCli({ bin: '/bin/x', exec }).serviceStart().catch((e: unknown) => e);
    expect((err as CliError).message).toBe('agentdeck-server service start failed: An AgentDeck server is already running outside the service (pid 7).');
  });

  it('wraps a program that cannot be started', async () => {
    const exec: Exec = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(createCli({ bin: '/missing/agentdeck-server', exec }).info()).rejects.toThrow(/Cannot run agentdeck-server: spawn ENOENT/);
  });

  it('rejects output that is not the contract', async () => {
    const { exec } = execReturning('{"version":"1"}');
    await expect(createCli({ bin: '/bin/x', exec }).info()).rejects.toThrow(CliError);
  });
});

describe('resolveServerBin', () => {
  const exists = (known: string[]) => async (file: string) => known.includes(file);

  it('prefers AGENTDECK_SERVER_BIN and never falls back from it', async () => {
    const env = { AGENTDECK_SERVER_BIN: '/opt/custom/agentdeck-server' };
    await expect(
      resolveServerBin({ env, resourcesPath: '/res', packaged: true, desktopDir: '/d', exists: exists(['/opt/custom/agentdeck-server']) }),
    ).resolves.toEqual({ bin: '/opt/custom/agentdeck-server', source: 'env' });
    await expect(
      resolveServerBin({ env, resourcesPath: '/res', packaged: true, desktopDir: '/d', exists: exists(['/res/server/bin/agentdeck-server']) }),
    ).rejects.toBeInstanceOf(ServerBinNotFoundError);
  });

  it('uses the bundle in the app resources when packaged', async () => {
    await expect(
      resolveServerBin({ env: {}, resourcesPath: '/opt/AgentDeck/resources', packaged: true, desktopDir: '/d', exists: exists(['/opt/AgentDeck/resources/server/bin/agentdeck-server']) }),
    ).resolves.toEqual({ bin: '/opt/AgentDeck/resources/server/bin/agentdeck-server', source: 'bundled' });
  });

  it('uses dist-bundle of the checkout in development', async () => {
    await expect(
      resolveServerBin({ env: {}, resourcesPath: '/res', packaged: false, desktopDir: '/repo/desktop', exists: exists(['/repo/dist-bundle/agentdeck-server/bin/agentdeck-server']) }),
    ).resolves.toEqual({ bin: '/repo/dist-bundle/agentdeck-server/bin/agentdeck-server', source: 'dev-bundle' });
  });

  it('lists what it tried when nothing is there', async () => {
    const err = await resolveServerBin({ env: {}, resourcesPath: '/res', packaged: true, desktopDir: '/d', exists: exists([]) }).catch((e: unknown) => e);
    expect((err as ServerBinNotFoundError).tried).toEqual(['/res/server/bin/agentdeck-server']);
  });
});

// The real exec path against a script on disk (no Electron, no systemd).
describe('nodeExec with a CLI script', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the fake agentdeck-server and parses its info', async () => {
    const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agentdeck-server.mjs');
    const cli = createCli({
      bin: fake,
      exec: nodeExec,
      env: { ...process.env, FAKE_DATA_DIR: dir, FAKE_PORT: '4999', FAKE_VERSION: '3.2.1' },
    });
    const info = await cli.info();
    expect(info).toMatchObject({ version: '3.2.1', port: 4999, dataDir: dir, packaged: true });
    expect((await cli.serviceStatus()).systemd).toBe(false);
  });

  it('reports exit code and stderr of a failing script', async () => {
    const script = path.join(dir, 'fail.sh');
    await writeFile(script, '#!/bin/sh\necho "unit exists" >&2\nexit 3\n');
    await chmod(script, 0o755);
    const result = await nodeExec(script, [], {});
    expect(result).toMatchObject({ code: 3, stderr: 'unit exists\n' });
  });

  it('rejects when the program does not exist and when it times out', async () => {
    await expect(nodeExec(path.join(dir, 'nope'), [], {})).rejects.toThrow();
    const sleeper = path.join(dir, 'sleep.sh');
    await writeFile(sleeper, '#!/bin/sh\nsleep 5\n');
    await chmod(sleeper, 0o755);
    await expect(nodeExec(sleeper, [], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
});
