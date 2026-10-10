import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectPidFile,
  looksLikeServer,
  pidFilePath,
  readPidFile,
  removePidFile,
  systemPidProbe,
  writePidFile,
  type PidProbe,
} from '../src/util/pidfile.js';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pid-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const probe = (alive: boolean, cmdline: string | undefined): PidProbe => ({ alive: () => alive, cmdline: () => cmdline });

describe('server.pid', () => {
  it('is written as plain text and read back', () => {
    writePidFile(dir, 4242);
    expect(fs.readFileSync(pidFilePath(dir), 'utf8')).toBe('4242\n');
    expect(readPidFile(dir)).toBe(4242);
  });

  it('creates the data dir when it is missing', () => {
    const nested = path.join(dir, 'a', 'b');
    writePidFile(nested, 7);
    expect(readPidFile(nested)).toBe(7);
  });

  it('is removed only by the process it names', () => {
    writePidFile(dir, 100);
    removePidFile(dir, 200);
    expect(readPidFile(dir)).toBe(100);
    removePidFile(dir, 100);
    expect(fs.existsSync(pidFilePath(dir))).toBe(false);
    removePidFile(dir, 100); // already gone: no throw
  });

  it('ignores garbage', () => {
    fs.writeFileSync(pidFilePath(dir), 'not a pid');
    expect(readPidFile(dir)).toBeUndefined();
    fs.writeFileSync(pidFilePath(dir), '0\n');
    expect(readPidFile(dir)).toBeUndefined();
    expect(inspectPidFile(dir, probe(true, 'node x'))).toBeUndefined();
  });
});

describe('stale pid detection', () => {
  it('has nothing to say without a file', () => {
    expect(inspectPidFile(dir, probe(true, 'node dist/index.js'))).toBeUndefined();
  });

  it('a dead process is stale', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(false, undefined))).toEqual({ pid: 555, running: false, stale: true });
  });

  it('a live AgentDeck server is running', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, '/usr/bin/node /home/me/agentdeck/server/dist/index.js'))).toEqual({
      pid: 555,
      running: true,
      stale: false,
    });
  });

  it('a reused pid (someone else’s process) is stale', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, '/usr/bin/vim notes.txt'))).toEqual({ pid: 555, running: false, stale: true });
  });

  it('trusts an existing process whose command line cannot be read', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, undefined))?.running).toBe(true);
  });

  it('recognizes the ways a server is started', () => {
    expect(looksLikeServer('/x/node/bin/node /x/app/server/dist/cli.js')).toBe(true);
    expect(looksLikeServer('node /home/me/agentdeck/server/dist/index.js')).toBe(true);
    expect(looksLikeServer('node --import tsx src/index.ts')).toBe(true);
    expect(looksLikeServer('/usr/bin/agentdeck-server')).toBe(true);
    expect(looksLikeServer('node server.js')).toBe(false);
  });

  it('the system probe sees this very process, and not a made-up one', () => {
    expect(systemPidProbe.alive(process.pid)).toBe(true);
    expect(systemPidProbe.alive(2 ** 22 + 12345)).toBe(false);
    const cmdline = systemPidProbe.cmdline(process.pid);
    if (cmdline !== undefined) expect(cmdline).toContain('node');
  });
});
