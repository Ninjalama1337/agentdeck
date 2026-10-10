import { describe, expect, it } from 'vitest';
import { createRestartLimiter } from '../src/core/restartLimit';
import { stageRuntime } from '../src/core/runtimeStage';
import { MemFs } from './helpers/memFs';

describe('createRestartLimiter', () => {
  it('allows three reloads a minute, then none until the minute has passed', () => {
    const limiter = createRestartLimiter(3, 60_000);
    expect([0, 1000, 2000].map((t) => limiter.allow(t))).toEqual([true, true, true]);
    expect(limiter.allow(3000)).toBe(false);
    expect(limiter.allow(59_000)).toBe(false);
    expect(limiter.allow(61_000)).toBe(true); // the first one has aged out
  });
});

describe('stageRuntime', () => {
  it('makes the copy writable by its owner before it is moved into place (read-only mount modes)', async () => {
    const fs = new MemFs({ '/tmp/.mount_x/server/bin/agentdeck-server': '#!/bin/sh' });
    await stageRuntime({ fs, bundleRoot: '/tmp/.mount_x/server', version: '1.0.0', runtimeDir: '/rt', pid: 7 });
    expect(fs.writable).toEqual(['/rt/.staging-1.0.0-7']);
    expect(await fs.exists('/rt/1.0.0/bin/agentdeck-server')).toBe(true);
  });
});
