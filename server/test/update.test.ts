import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '@agentdeck/shared';
import { REPO_ROOT, versionFromDescribe } from '../src/version.js';
import { isNewerRelease, parseVersion, type ReleaseInfo } from '../src/update/release.js';
import { UpdateManager, type UpdateChild } from '../src/update/manager.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';

let tmp = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-update-'));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('version from git tags', () => {
  it('reads releases and commits past a release', () => {
    expect(versionFromDescribe('v1.2.3\n')).toBe('1.2.3');
    expect(versionFromDescribe('v0.11.0-4-gabc1234')).toBe('0.11.0-4-gabc1234');
  });

  it('ignores anything that is not a release tag', () => {
    expect(versionFromDescribe('nightly')).toBeUndefined();
    expect(versionFromDescribe('v1.2')).toBeUndefined();
    expect(versionFromDescribe('')).toBeUndefined();
  });
});

describe('release comparison', () => {
  it('parses plain, prefixed and past-release versions', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.11.0-4-gabc1234')).toEqual([0, 11, 0]);
    expect(parseVersion('latest')).toBeUndefined();
  });

  it('only a higher release number is an update', () => {
    expect(isNewerRelease('0.11.1', '0.11.0')).toBe(true);
    expect(isNewerRelease('0.12.0', '0.11.9')).toBe(true);
    expect(isNewerRelease('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerRelease('0.11.0', '0.11.0')).toBe(false);
    expect(isNewerRelease('0.10.9', '0.11.0')).toBe(false);
    // A checkout a few commits past the release already contains it.
    expect(isNewerRelease('0.11.0', '0.11.0-3-gabc1234')).toBe(false);
    expect(isNewerRelease('0.11.1', '0.11.0-3-gabc1234')).toBe(true);
  });
});

const release = (version: string): ReleaseInfo => ({ tag: `v${version}`, version, url: `https://example.test/${version}` });

interface FakeRun {
  child: UpdateChild;
  stdout: PassThrough;
  finish(exitCode: number): void;
  script: string;
  tag: string;
  env: Record<string, string>;
}

function makeManager(opts: { current: string; latest: ReleaseInfo | null | Error; repoRoot?: string }) {
  const broadcasts: UpdateInfo[] = [];
  const runs: FakeRun[] = [];
  const fetchRelease = vi.fn(async () => {
    if (opts.latest instanceof Error) throw opts.latest;
    return opts.latest;
  });
  const manager = new UpdateManager({
    repoRoot: opts.repoRoot ?? REPO_ROOT,
    currentVersion: opts.current,
    dataDir: tmp,
    localUrl: 'http://127.0.0.1:8787',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    broadcast: ((event: string, payload: { update: UpdateInfo }) => {
      if (event === 'update:state') broadcasts.push(payload.update);
    }) as never,
    fetchRelease,
    spawn: (script, tag, env) => {
      const stdout = new PassThrough();
      let resolve!: (r: { exitCode?: number }) => void;
      const done = new Promise<{ exitCode?: number }>((r) => (resolve = r));
      const child: UpdateChild = { stdout, stderr: null, kill: () => undefined, done };
      runs.push({
        child,
        stdout,
        script,
        tag,
        env,
        finish: (exitCode) => {
          stdout.end();
          resolve({ exitCode });
        },
      });
      return child;
    },
  });
  return { manager, broadcasts, runs, fetchRelease };
}

describe('UpdateManager', () => {
  it('reports an available release and caches the GitHub answer', async () => {
    const { manager, fetchRelease } = makeManager({ current: '0.11.0', latest: release('0.12.0') });
    const info = await manager.info();
    expect(info).toMatchObject({ current: '0.11.0', updateAvailable: true, latest: { version: '0.12.0', tag: 'v0.12.0' } });
    expect(info.blockedReason).toBeUndefined();
    await manager.info();
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    await manager.info(true);
    expect(fetchRelease).toHaveBeenCalledTimes(2);
  });

  it('is up to date on the latest release and without any release', async () => {
    expect((await makeManager({ current: '0.12.0', latest: release('0.12.0') }).manager.info()).updateAvailable).toBe(false);
    const none = await makeManager({ current: '0.1.0', latest: null }).manager.info();
    expect(none.updateAvailable).toBe(false);
    expect(none.latest).toBeUndefined();
  });

  it('surfaces a failed check instead of pretending to be up to date', async () => {
    const { manager } = makeManager({ current: '0.11.0', latest: new Error('GitHub CLI is not logged in') });
    const info = await manager.info();
    expect(info.checkError).toMatch(/not logged in/);
    expect(info.updateAvailable).toBe(false);
    await expect(manager.start()).rejects.toMatchObject({ statusCode: 502 });
  });

  it('runs scripts/update.sh for the latest tag and streams its output', async () => {
    const { manager, broadcasts, runs } = makeManager({ current: '0.11.0', latest: release('0.12.0') });
    const started = await manager.start();
    expect(started.job).toMatchObject({ target: '0.12.0', status: 'running' });
    expect(runs).toHaveLength(1);
    const run = runs[0] as FakeRun;
    expect(run.script).toBe(path.join(REPO_ROOT, 'scripts', 'update.sh'));
    expect(run.tag).toBe('v0.12.0');
    expect(run.env).toMatchObject({
      AGENTDECK_SERVER_PID: String(process.pid),
      AGENTDECK_URL: 'http://127.0.0.1:8787',
      AGENTDECK_DATA_DIR: tmp,
    });

    // A second start while it runs is refused.
    await expect(manager.start()).rejects.toMatchObject({ statusCode: 409, code: 'UPDATE_RUNNING' });

    run.stdout.write('==> Hole v0.12.0 von origin …\n==> Baue (npm run build) …\n');
    run.finish(0);
    await manager.idle();

    const last = broadcasts.at(-1) as UpdateInfo;
    expect(last.job).toMatchObject({ status: 'done', target: '0.12.0' });
    expect(last.job?.output).toEqual(['==> Hole v0.12.0 von origin …', '==> Baue (npm run build) …']);
    expect(await fsp.readFile(path.join(tmp, 'update.log'), 'utf8')).toContain('Baue (npm run build)');
  });

  it('reports a failed update and allows a retry', async () => {
    const { manager, runs } = makeManager({ current: '0.11.0', latest: release('0.12.0') });
    await manager.start();
    (runs[0] as FakeRun).stdout.write('FEHLER: Der Checkout hat uncommittete Aenderungen\n');
    (runs[0] as FakeRun).finish(1);
    await manager.idle();
    const info = manager.snapshot();
    expect(info.job).toMatchObject({ status: 'error' });
    expect(info.job?.error).toMatch(/exit code 1/);
    await manager.start();
    expect(runs).toHaveLength(2);
    (runs[1] as FakeRun).finish(0);
    await manager.idle();
  });

  it('refuses when there is nothing to update to', async () => {
    const { manager, runs } = makeManager({ current: '0.12.0', latest: release('0.12.0') });
    await expect(manager.start()).rejects.toMatchObject({ statusCode: 409, code: 'UPDATE_NOT_NEEDED' });
    expect(runs).toHaveLength(0);
  });

  it('explains why an install outside a git checkout cannot update itself', async () => {
    const { manager, runs } = makeManager({ current: '0.11.0', latest: release('0.12.0'), repoRoot: tmp });
    expect((await manager.info()).blockedReason).toMatch(/git checkout/);
    await expect(manager.start()).rejects.toMatchObject({ statusCode: 409, code: 'UPDATE_UNAVAILABLE' });
    expect(runs).toHaveLength(0);
  });
});

describe('update routes', () => {
  it('need a paired device and hand through the manager state', async () => {
    const dataDir = path.join(tmp, 'routes');
    const config = loadConfig({ env: { AGENTDECK_DATA_DIR: dataDir, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
    const { app, deps } = await buildApp(config);
    try {
      const { manager } = makeManager({ current: '0.11.0', latest: release('0.12.0') });
      deps.update = manager;
      const jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_update_1', name: 'Update Test' });
      const auth = { authorization: `Bearer ${jwt}` };

      expect((await app.inject({ method: 'GET', url: '/api/update' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/update' })).statusCode).toBe(401);

      const info = await app.inject({ method: 'GET', url: '/api/update', headers: auth });
      expect(info.statusCode).toBe(200);
      expect(info.json()).toMatchObject({ current: '0.11.0', updateAvailable: true });

      const started = await app.inject({ method: 'POST', url: '/api/update', headers: auth });
      expect(started.statusCode).toBe(202);
      expect(started.json().job).toMatchObject({ target: '0.12.0', status: 'running' });
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
