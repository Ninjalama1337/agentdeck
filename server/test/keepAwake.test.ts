import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inhibitorFor, KEEP_AWAKE_GRACE_MS, KeepAwake } from '../src/power/keepAwake.js';

const log = { info: () => undefined, warn: () => undefined };

function fakeChild(): ChildProcess & { killed_: boolean } {
  const c = new EventEmitter() as ChildProcess & { killed_: boolean };
  c.killed_ = false;
  (c as { kill: () => boolean }).kill = () => {
    c.killed_ = true;
    return true;
  };
  return c;
}

function setup() {
  let now = 1_000_000;
  let busy: string | null = null;
  const children: ReturnType<typeof fakeChild>[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-power-'));
  const ka = new KeepAwake({
    dataDir,
    busy: () => busy,
    log,
    inhibitor: { command: 'inhibit', args: [] },
    spawnProcess: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
    now: () => now,
  });
  return {
    ka,
    children,
    dataDir,
    setBusy: (b: string | null) => (busy = b),
    advance: (ms: number) => (now += ms),
  };
}

describe('KeepAwake', () => {
  it('holds the lock while busy and lets go after the grace period', () => {
    const t = setup();
    t.ka.tick();
    expect(t.children).toHaveLength(0);
    t.setBusy('1 agent working');
    t.ka.tick();
    expect(t.ka.status()).toMatchObject({ active: true, reason: '1 agent working' });
    t.setBusy(null);
    t.advance(KEEP_AWAKE_GRACE_MS - 1000);
    t.ka.tick();
    expect(t.children[0]!.killed_).toBe(false);
    t.advance(2000);
    t.ka.tick();
    expect(t.children[0]!.killed_).toBe(true);
    expect(t.ka.status().active).toBe(false);
  });

  it('switches off, remembers it, and reports a refused lock', () => {
    const t = setup();
    t.setBusy('x');
    t.ka.setEnabled(false);
    expect(t.children).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'power.json'), 'utf8'))).toEqual({ keepAwake: false });
    t.ka.setEnabled(true);
    t.children[0]!.emit('exit', 1);
    expect(t.ka.status()).toMatchObject({ active: false, error: 'inhibit exited with 1' });
  });

  it('picks the platform tool', () => {
    expect(inhibitorFor('linux', () => true)?.command).toBe('systemd-inhibit');
    expect(inhibitorFor('darwin', () => true)?.command).toBe('caffeinate');
    expect(inhibitorFor('win32', () => true)).toBeNull();
    expect(inhibitorFor('linux', () => false)).toBeNull();
  });
});
