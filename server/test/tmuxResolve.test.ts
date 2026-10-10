import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTmux, resolveTmuxBinary } from '../src/term/tmux.js';

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

  it('passes over a tmux that does not run and reports it', () => {
    const bundled = fakeTmux('bundle', 'bin', 'tmux');
    const system = fakeTmux('sys', 'tmux');
    const probe = (bin: string) => (bin === bundled ? 'version `GLIBC_2.38\' not found' : undefined);
    const resolved = resolveTmux({ env: {}, bundleRoot: path.join(tmp, 'bundle'), pathValue: path.join(tmp, 'sys'), probe });
    expect(resolved.bin).toBe(system);
    expect(resolved.rejected).toEqual([{ path: bundled, reason: 'version `GLIBC_2.38\' not found' }]);
  });

  it('has no tmux when none of the candidates runs', () => {
    const system = fakeTmux('sys', 'tmux');
    const resolved = resolveTmux({ env: {}, bundleRoot: undefined, pathValue: path.join(tmp, 'sys'), probe: () => 'broken' });
    expect(resolved.bin).toBeUndefined();
    expect(resolved.rejected).toEqual([{ path: system, reason: 'broken' }]);
  });

  it('asks each distinct candidate once', () => {
    const same = fakeTmux('sys', 'tmux');
    const asked: string[] = [];
    resolveTmux({ env: { AGENTDECK_TMUX: same }, bundleRoot: undefined, pathValue: path.join(tmp, 'sys'), probe: (bin) => (asked.push(bin), 'no') });
    expect(asked).toEqual([same]);
  });

  it('really runs `tmux -V` by default', () => {
    const good = path.join(tmp, 'good-tmux');
    const bad = path.join(tmp, 'bad-tmux');
    fs.writeFileSync(good, '#!/bin/sh\necho "tmux 9.9"\n', { mode: 0o755 });
    fs.writeFileSync(bad, '#!/bin/sh\necho "libc.so.6: version GLIBC_2.99 not found" >&2\nexit 127\n', { mode: 0o755 });
    const resolved = resolveTmux({ env: { AGENTDECK_TMUX: bad }, bundleRoot: undefined, pathValue: tmp + ':' + path.dirname(good) });
    expect(resolved.rejected[0]).toMatchObject({ path: bad });
    expect(resolved.rejected[0]?.reason).toContain('GLIBC_2.99');
    expect(resolveTmux({ env: { AGENTDECK_TMUX: good }, bundleRoot: undefined, pathValue: '' }).bin).toBe(good);
  });
});
