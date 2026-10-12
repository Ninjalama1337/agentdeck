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

const probe = (alive: boolean, cmdline: string[] | undefined, extra: Partial<PidProbe> = {}): PidProbe => ({
  alive: () => alive,
  cmdline: () => cmdline,
  ...extra,
});

/** A probe that knows these package.json names (everything else is unreadable). */
const knowing = (names: Record<string, string>) => (file: string) => names[file];

describe('server.pid', () => {
  it('is written as plain text and read back', () => {
    expect(writePidFile(dir, 4242)).toEqual({ written: true });
    expect(fs.readFileSync(pidFilePath(dir), 'utf8')).toBe('4242\n');
    expect(readPidFile(dir)).toBe(4242);
  });

  it('is written atomically with no temp file left behind', () => {
    writePidFile(dir, 4242);
    expect(fs.readdirSync(dir)).toEqual(['server.pid']);
    expect(fs.statSync(pidFilePath(dir)).mode & 0o777).toBe(0o644);
  });

  it('does not take the file from another live server, but replaces a stale one', () => {
    const server = ['node', '/x/server/dist/index.js'];
    const known = { packageName: knowing({ '/x/server/package.json': '@agentdeck/server' }) };
    writePidFile(dir, 100);
    expect(writePidFile(dir, 200, probe(true, server, known))).toEqual({ written: false, otherPid: 100 });
    expect(readPidFile(dir)).toBe(100);
    // the other one is gone / was someone else's pid
    expect(writePidFile(dir, 200, probe(false, undefined))).toEqual({ written: true });
    expect(readPidFile(dir)).toBe(200);
    expect(writePidFile(dir, 300, probe(true, ['vim', 'notes.txt']))).toEqual({ written: true });
    expect(readPidFile(dir)).toBe(300);
    // rewriting its own file is fine
    expect(writePidFile(dir, 300, probe(true, server, known))).toEqual({ written: true });
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
  const server = ['/usr/bin/node', '/home/me/agentdeck/server/dist/index.js'];
  const known = { packageName: knowing({ '/home/me/agentdeck/server/package.json': '@agentdeck/server' }) };

  it('has nothing to say without a file', () => {
    expect(inspectPidFile(dir, probe(true, server, known))).toBeUndefined();
  });

  it('a dead process is stale', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(false, undefined))).toEqual({ pid: 555, running: false, stale: true });
  });

  it('a live AgentDeck server is running', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, server, known))).toEqual({ pid: 555, running: true, stale: false });
  });

  it('a reused pid (someone else’s process) is stale', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, ['/usr/bin/vim', 'notes.txt']))).toEqual({ pid: 555, running: false, stale: true });
  });

  it('trusts an existing process whose command line cannot be read', () => {
    writePidFile(dir, 555);
    expect(inspectPidFile(dir, probe(true, undefined))?.running).toBe(true);
  });

  it('resolves a relative script against the process’s working directory (npm start in server/)', () => {
    writePidFile(dir, 555);
    const p = probe(true, ['node', 'dist/index.js'], {
      cwd: () => '/home/me/agentdeck/server',
      packageName: knowing({ '/home/me/agentdeck/server/package.json': '@agentdeck/server' }),
    });
    expect(inspectPidFile(dir, p)?.running).toBe(true);
  });

  it('the system probe sees this very process, and not a made-up one', () => {
    expect(systemPidProbe.alive(process.pid)).toBe(true);
    expect(systemPidProbe.alive(2 ** 22 + 12345)).toBe(false);
    const cmdline = systemPidProbe.cmdline(process.pid);
    if (cmdline !== undefined) expect(cmdline.join(' ')).toContain('node');
  });
});

describe('looksLikeServer', () => {
  const pkg = (...dirs: string[]) => ({
    packageName: knowing(Object.fromEntries(dirs.map((d) => [`${d}/package.json`, '@agentdeck/server']))),
  });

  it('knows the ways an AgentDeck server is started', () => {
    // bundle (service or desktop app)
    expect(looksLikeServer(['/x/runtime/1.0.0/node/bin/node', '/x/runtime/1.0.0/app/server/dist/cli.js'], pkg('/x/runtime/1.0.0/app/server'))).toBe(true);
    // checkout: systemd unit, restart.sh, npm start in server/, tsx
    expect(looksLikeServer(['node', '/home/me/agentdeck/server/dist/index.js'], pkg('/home/me/agentdeck/server'))).toBe(true);
    expect(looksLikeServer(['node', 'server/dist/index.js'], { cwd: '/home/me/agentdeck', ...pkg('/home/me/agentdeck/server') })).toBe(true);
    expect(looksLikeServer(['node', '--import', 'tsx', '/r/server/src/index.ts'], pkg('/r/server'))).toBe(true);
    // the launcher itself
    expect(looksLikeServer(['/opt/AgentDeck/resources/server/bin/agentdeck-server', '--lan'])).toBe(true);
    expect(looksLikeServer(['/bin/sh', '/opt/x/bin/agentdeck-server'])).toBe(true);
  });

  it('is not fooled by other programs that merely mention the names', () => {
    expect(looksLikeServer(['vim', 'agentdeck-server.md'])).toBe(false);
    expect(looksLikeServer(['vim', '/opt/x/bin/agentdeck-server'])).toBe(false);
    expect(looksLikeServer(['grep', '-r', 'agentdeck-server', '.'])).toBe(false);
    expect(looksLikeServer(['node', '/anderes/projekt/dist/cli.js'])).toBe(false);
    expect(looksLikeServer(['node', 'dist/index.js'], { cwd: '/anderes/projekt' })).toBe(false);
    // another project's server/dist/index.js — wrong package name, or no package.json at all
    expect(looksLikeServer(['node', '/o/server/dist/index.js'], { packageName: knowing({ '/o/server/package.json': 'other-server' }) })).toBe(false);
    expect(looksLikeServer(['node', '/o/server/dist/index.js'], { packageName: knowing({}) })).toBe(false);
    // a relative path without a known cwd cannot be judged
    expect(looksLikeServer(['node', 'server/dist/index.js'], pkg('/x/server'))).toBe(false);
    expect(looksLikeServer([])).toBe(false);
  });
});
