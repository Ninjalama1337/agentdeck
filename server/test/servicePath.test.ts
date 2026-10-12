import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { augmentedPath, extraBinDirs, findExecutable } from '../src/term/presets.js';

/** What a systemd user service (or a desktop launcher) hands us: a bare PATH. */
const SYSTEMD_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin';

let home = '';
let oldHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-home-'));
  oldHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function install(...parts: string[]): string {
  const file = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

describe('PATH of a service started without a login shell', () => {
  it('finds agent CLIs installed the usual per-user ways', () => {
    const claudeNative = install('.local', 'bin', 'claude');
    const codexNpm = install('.npm-global', 'bin', 'codex');
    const opencode = install('.opencode', 'bin', 'opencode');
    const viaNvm = install('.nvm', 'versions', 'node', 'v22.5.0', 'bin', 'gemini');
    const viaVolta = install('.volta', 'bin', 'aider');
    const pathValue = augmentedPath(SYSTEMD_PATH);
    expect(findExecutable('claude', pathValue)).toBe(claudeNative);
    expect(findExecutable('codex', pathValue)).toBe(codexNpm);
    expect(findExecutable('opencode', pathValue)).toBe(opencode);
    expect(findExecutable('gemini', pathValue)).toBe(viaNvm);
    expect(findExecutable('aider', pathValue)).toBe(viaVolta);
  });

  it('keeps the inherited PATH first and adds each dir once', () => {
    const parts = augmentedPath(`${SYSTEMD_PATH}:${home}/.local/bin`).split(':');
    expect(parts.slice(0, 4)).toEqual(SYSTEMD_PATH.split(':'));
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('still finds tmux and the shell tools when the inherited PATH is empty', () => {
    const dirs = augmentedPath('').split(':');
    expect(dirs).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/usr/local/bin']));
    expect(findExecutable('sh', augmentedPath(''))).toBeDefined();
  });

  it('lists the home-relative dirs under the given home', () => {
    expect(extraBinDirs('/h')).toEqual(expect.arrayContaining(['/h/.local/bin', '/h/.npm-global/bin', '/h/.volta/bin']));
  });
});
