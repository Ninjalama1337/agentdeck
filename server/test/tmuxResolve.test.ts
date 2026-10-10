import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTmuxBinary } from '../src/term/tmux.js';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-tmuxres-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeTmux(...parts: string[]): string {
  const file = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

describe('resolveTmuxBinary', () => {
  it('prefers AGENTDECK_TMUX over the bundled and the system tmux', () => {
    const custom = fakeTmux('custom', 'tmux-x');
    fakeTmux('bundle', 'bin', 'tmux');
    fakeTmux('sys', 'tmux');
    expect(
      resolveTmuxBinary({ env: { AGENTDECK_TMUX: custom }, bundleRoot: path.join(tmp, 'bundle'), pathValue: path.join(tmp, 'sys') }),
    ).toBe(custom);
  });

  it('takes the bundled tmux over the one on PATH', () => {
    const bundled = fakeTmux('bundle', 'bin', 'tmux');
    fakeTmux('sys', 'tmux');
    expect(resolveTmuxBinary({ env: {}, bundleRoot: path.join(tmp, 'bundle'), pathValue: path.join(tmp, 'sys') })).toBe(bundled);
  });

  it('falls back to tmux on PATH', () => {
    const system = fakeTmux('sys', 'tmux');
    expect(resolveTmuxBinary({ env: {}, bundleRoot: path.join(tmp, 'bundle'), pathValue: path.join(tmp, 'sys') })).toBe(system);
    expect(resolveTmuxBinary({ env: {}, bundleRoot: undefined, pathValue: path.join(tmp, 'sys') })).toBe(system);
  });

  it('accepts AGENTDECK_TMUX as a bare name looked up on PATH', () => {
    const named = fakeTmux('sys', 'tmux-next');
    expect(resolveTmuxBinary({ env: { AGENTDECK_TMUX: 'tmux-next' }, bundleRoot: undefined, pathValue: path.join(tmp, 'sys') })).toBe(named);
  });

  it('ignores an AGENTDECK_TMUX that is not usable', () => {
    const bundled = fakeTmux('bundle', 'bin', 'tmux');
    expect(
      resolveTmuxBinary({ env: { AGENTDECK_TMUX: path.join(tmp, 'nope') }, bundleRoot: path.join(tmp, 'bundle'), pathValue: '' }),
    ).toBe(bundled);
    expect(resolveTmuxBinary({ env: { AGENTDECK_TMUX: ' ' }, bundleRoot: undefined, pathValue: '' })).toBeUndefined();
  });

  it('skips a bundled tmux that is not executable', () => {
    const file = path.join(tmp, 'bundle', 'bin', 'tmux');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    const system = fakeTmux('sys', 'tmux');
    expect(resolveTmuxBinary({ env: {}, bundleRoot: path.join(tmp, 'bundle'), pathValue: path.join(tmp, 'sys') })).toBe(system);
  });

  it('finds nothing when there is no tmux anywhere', () => {
    expect(resolveTmuxBinary({ env: {}, bundleRoot: undefined, pathValue: path.join(tmp, 'empty') })).toBeUndefined();
  });
});
