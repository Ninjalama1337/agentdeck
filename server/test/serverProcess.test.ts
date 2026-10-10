import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectPidFile } from '../src/util/pidfile.js';

const SERVER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let tmp = '';
let child: ChildProcess | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-proc-'));
});

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function start(entry: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', path.join(SERVER_DIR, entry)], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: tmp,
      AGENTDECK_DATA_DIR: path.join(tmp, 'data'),
      AGENTDECK_CONFIG: path.join(tmp, 'none.json'),
      AGENTDECK_HOST: '127.0.0.1',
      AGENTDECK_PORT: '0',
      AGENTDECK_TUNNEL: 'off',
    },
  });
}

describe('server.pid', () => {
  // Both entry points: the checkout's index.ts and the packaged cli.ts.
  for (const entry of ['src/index.ts', 'src/cli.ts']) {
    it(`${entry} writes its pid once listening and removes it on SIGTERM`, async () => {
      const pidFile = path.join(tmp, 'data', 'server.pid');
      child = start(entry);
      const exited = new Promise<number | null>((resolve) => child?.once('exit', (code) => resolve(code)));
      await until(() => fs.existsSync(pidFile));
      expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));
      expect(inspectPidFile(path.join(tmp, 'data'))).toEqual({ pid: child.pid, running: true, stale: false });
      // the pairing code the desktop app reads is private to the user
      expect(fs.statSync(path.join(tmp, 'data', 'pairing-code.txt')).mode & 0o777).toBe(0o600);

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(fs.existsSync(pidFile)).toBe(false);
    });
  }

  it('a killed server leaves a stale pid file behind that is recognized as stale', async () => {
    const dataDir = path.join(tmp, 'data');
    child = start('src/index.ts');
    const exited = new Promise((resolve) => child?.once('exit', resolve));
    await until(() => fs.existsSync(path.join(dataDir, 'server.pid')));
    child.kill('SIGKILL');
    await exited;
    expect(fs.existsSync(path.join(dataDir, 'server.pid'))).toBe(true);
    expect(inspectPidFile(dataDir)).toMatchObject({ running: false, stale: true });
  });
});
