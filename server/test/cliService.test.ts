import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_UNIT_MARKER } from '@agentdeck/shared';
import { CliError, type ExecFn } from '../src/cli/exec.js';
import { noProc, type ProcAccess } from '../src/cli/proc.js';
import { launcherPath } from '../src/cli/runtime.js';
import {
  serviceControl,
  serviceInstall,
  servicePaths,
  serviceStatus,
  serviceUninstall,
  type ServiceContext,
} from '../src/cli/service.js';
import { parseUnit } from '../src/cli/unit.js';
import { writePidFile, type PidProbe } from '../src/util/pidfile.js';

/** An in-memory `systemctl --user`: a unit that is enabled/active or not, and a log of calls. */
class FakeSystemctl {
  available = true;
  enabled = false;
  active = false;
  /** Make `start`/`enable --now`/`restart` leave the unit dead (a crashing service). */
  crashes = false;
  mainPid = 4711;
  /** `restart` fails (the unit and the symlink are already changed by then). */
  failRestart = false;
  /** Called whenever the unit (re)starts — the fake process is whatever the files say at that moment. */
  onStart: (() => void) | undefined;
  calls: string[] = [];

  exec: ExecFn = async (command, args) => {
    if (command !== 'systemctl') throw new Error(`unexpected command ${command}`);
    const [user, verb, ...rest] = args;
    if (user !== '--user') throw new Error('systemctl must be called with --user');
    this.calls.push([verb, ...rest].join(' '));
    const ok = { code: 0, stdout: '', stderr: '' };
    if (!this.available) return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
    switch (verb) {
      case 'show-environment':
        return ok;
      case 'show':
        return {
          ...ok,
          stdout: [
            `ActiveState=${this.active ? 'active' : 'inactive'}`,
            `UnitFileState=${this.enabled ? 'enabled' : 'disabled'}`,
            `MainPID=${this.active ? this.mainPid : 0}`,
          ].join('\n'),
        };
      case 'enable':
        this.enabled = true;
        if (rest.includes('--now')) this.started();
        return ok;
      case 'disable':
        this.enabled = false;
        return ok;
      case 'restart':
        if (this.failRestart) return { code: 1, stdout: '', stderr: 'Job for agentdeck.service failed' };
        this.started();
        return ok;
      case 'start':
        this.started();
        return ok;
      case 'stop':
        this.active = false;
        return ok;
      case 'daemon-reload':
        return ok;
      default:
        throw new Error(`unexpected systemctl verb ${verb}`);
    }
  };

  private started(): void {
    this.active = !this.crashes;
    if (this.active) this.onStart?.();
  }
}

/** The service's main process as /proc would show it: set when the fake unit starts, from the files at that moment. */
class FakeProc implements ProcAccess {
  running: { exe: string; env: Record<string, string> } | undefined;
  exe(): string | undefined {
    return this.running?.exe;
  }
  environ(): Record<string, string> | undefined {
    return this.running?.env;
  }
  /** What `systemctl start` would exec right now. */
  startFrom(ctx: ServiceContext): void {
    const dir = fs.realpathSync(ctx.paths.currentLink);
    const unit = parseUnit(fs.readFileSync(ctx.paths.unitPath, 'utf8'));
    this.running = {
      exe: path.join(dir, 'node/bin/node'),
      env: { ...(unit.host ? { AGENTDECK_HOST: unit.host } : {}), ...(unit.port ? { AGENTDECK_PORT: String(unit.port) } : {}) },
    };
  }
}

let tmp = '';
let sys: FakeSystemctl;
let messages: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-service-'));
  sys = new FakeSystemctl();
  messages = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeBundle(version: string, name = `bundle-${version}`): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/agentdeck-server'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'node/bin/node'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version }));
  return root;
}

function context(bundleRoot: string | undefined, overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    exec: sys.exec,
    paths: servicePaths({ XDG_DATA_HOME: path.join(tmp, 'data'), XDG_CONFIG_HOME: path.join(tmp, 'config') }, path.join(tmp, 'home')),
    bundleRoot,
    report: (m) => messages.push(m),
    settleMs: 0,
    proc: noProc,
    ...overrides,
  };
}

const unitText = (ctx: ServiceContext) => fs.readFileSync(ctx.paths.unitPath, 'utf8');

describe('service paths', () => {
  it('put the unit in the XDG config dir', () => {
    expect(servicePaths({ XDG_CONFIG_HOME: '/c' }, '/h').unitPath).toBe('/c/systemd/user/agentdeck.service');
    expect(servicePaths({}, '/h').unitPath).toBe('/h/.config/systemd/user/agentdeck.service');
  });
});

describe('service status', () => {
  it('reports a machine without systemd', async () => {
    sys.available = false;
    const status = await serviceStatus(context(undefined));
    expect(status).toEqual({
      systemd: false,
      installed: false,
      managed: false,
      enabled: false,
      active: false,
      unitPath: context(undefined).paths.unitPath,
      lan: false,
    });
  });

  it('reports a running, installed service', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: true });
    const status = await serviceStatus(ctx);
    expect(status).toMatchObject({
      systemd: true,
      installed: true,
      managed: true,
      enabled: true,
      active: true,
      mainPid: 4711,
      lan: true,
      runtimeVersion: '1.2.3',
    });
  });

  it('knows a foreign unit is not ours', async () => {
    const ctx = context(undefined);
    fs.mkdirSync(path.dirname(ctx.paths.unitPath), { recursive: true });
    fs.writeFileSync(ctx.paths.unitPath, '[Service]\nExecStart=/usr/bin/env node %h/agentdeck/server/dist/index.js\n');
    expect(await serviceStatus(ctx)).toMatchObject({ installed: true, managed: false, lan: false });
    expect((await serviceStatus(ctx)).runtimeVersion).toBeUndefined();
  });
});

describe('service install', () => {
  it('copies the runtime, writes the unit, and enables + starts it', async () => {
    const ctx = context(makeBundle('1.2.3'));
    const status = await serviceInstall(ctx, { lan: false });

    const runtime = path.join(ctx.paths.runtimeRoot, '1.2.3');
    expect(fs.existsSync(path.join(runtime, 'bin/agentdeck-server'))).toBe(true);
    expect(fs.readlinkSync(ctx.paths.currentLink)).toBe('1.2.3');

    const text = unitText(ctx);
    expect(text.split('\n')[0]).toBe(SERVICE_UNIT_MARKER);
    expect(text).toContain(`ExecStart=${path.join(ctx.paths.runtimeRoot, 'current/bin/agentdeck-server')}`);
    expect(text).toContain('Environment=AGENTDECK_HOST=127.0.0.1');
    expect(text).not.toContain('AGENTDECK_PORT');

    expect(sys.calls).toEqual([
      'show-environment',
      expect.stringMatching(/^show agentdeck\.service/),
      'daemon-reload',
      'enable --now agentdeck.service',
      expect.stringMatching(/^show agentdeck\.service/), // staying-up check
      expect.stringMatching(/^show-environment/), // status
      expect.stringMatching(/^show agentdeck\.service/),
    ]);
    expect(status).toMatchObject({ systemd: true, installed: true, managed: true, enabled: true, active: true, runtimeVersion: '1.2.3' });
  });

  it('never points the unit at the bundle it was started from', async () => {
    const bundle = makeBundle('1.2.3', 'fake.mount_AbC123');
    const ctx = context(bundle);
    await serviceInstall(ctx, { lan: false });
    expect(unitText(ctx)).not.toContain(bundle);
    expect(unitText(ctx)).toContain(launcherPath(ctx.paths));
  });

  it('pins the port only on request and keeps it across reinstalls', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false, port: 9100 });
    expect(parseUnit(unitText(ctx)).port).toBe(9100);
    // a later install (new app version) without --port keeps it ...
    const next = context(makeBundle('1.3.0'));
    await serviceInstall(next, { lan: false });
    expect(parseUnit(unitText(next)).port).toBe(9100);
    // ... and --port changes it
    await serviceInstall(next, { lan: false, port: 9200 });
    expect(parseUnit(unitText(next)).port).toBe(9200);
  });

  it('--lan binds all interfaces; dropping it goes back to loopback (and restarts)', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: true });
    expect(parseUnit(unitText(ctx))).toMatchObject({ lan: true, host: '0.0.0.0' });
    sys.calls.length = 0;
    await serviceInstall(ctx, { lan: false });
    expect(parseUnit(unitText(ctx))).toMatchObject({ lan: false, host: '127.0.0.1' });
    expect(sys.calls).toContain('daemon-reload');
    expect(sys.calls).toContain('restart agentdeck.service');
  });

  it('is idempotent: installing the same thing again changes nothing and does not restart', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    const before = unitText(ctx);
    sys.calls.length = 0;
    messages.length = 0;
    await serviceInstall(ctx, { lan: false });
    expect(unitText(ctx)).toBe(before);
    expect(sys.calls.some((c) => c.startsWith('restart') || c.startsWith('daemon-reload'))).toBe(false);
    expect(messages).toContain('The service already runs this version');
  });

  it('a newer app version updates the running service with a restart and keeps the old runtime', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    sys.calls.length = 0;
    await serviceInstall(context(makeBundle('1.3.0')), { lan: false });
    expect(fs.readlinkSync(ctx.paths.currentLink)).toBe('1.3.0');
    expect(sys.calls).toContain('restart agentdeck.service');
    expect(fs.readdirSync(ctx.paths.runtimeRoot).sort()).toEqual(['1.2.3', '1.3.0', 'current']);
    expect((await serviceStatus(ctx)).runtimeVersion).toBe('1.3.0');
  });

  it('prunes to the last two runtimes', async () => {
    const ctx = context(undefined);
    for (const [i, v] of ['1.0.0', '1.1.0', '1.2.0'].entries()) {
      await serviceInstall({ ...ctx, bundleRoot: makeBundle(v) }, { lan: false });
      // distinct install times, oldest first
      const dir = path.join(ctx.paths.runtimeRoot, v);
      const t = new Date(Date.now() - (3 - i) * 60_000);
      fs.utimesSync(dir, t, t);
    }
    await serviceInstall({ ...ctx, bundleRoot: makeBundle('1.3.0') }, { lan: false });
    expect(fs.readdirSync(ctx.paths.runtimeRoot).sort()).toEqual(['1.2.0', '1.3.0', 'current']);
  });

  it('--no-start only enables the unit', async () => {
    const ctx = context(makeBundle('1.2.3'));
    const status = await serviceInstall(ctx, { lan: false, start: false });
    expect(sys.calls).toContain('enable agentdeck.service');
    expect(sys.calls.some((c) => c.includes('--now') || c.startsWith('start') || c.startsWith('restart'))).toBe(false);
    expect(status).toMatchObject({ enabled: true, active: false });
  });

  it('starts an installed but stopped service', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    sys.active = false;
    sys.calls.length = 0;
    await serviceInstall(ctx, { lan: false });
    expect(sys.calls).toContain('enable --now agentdeck.service');
  });

  it('refuses to overwrite a unit it did not write — unless --force', async () => {
    const ctx = context(makeBundle('1.2.3'));
    fs.mkdirSync(path.dirname(ctx.paths.unitPath), { recursive: true });
    const foreign = '[Service]\nExecStart=/usr/bin/env node %h/agentdeck/server/dist/index.js\n';
    fs.writeFileSync(ctx.paths.unitPath, foreign);
    await expect(serviceInstall(ctx, { lan: false })).rejects.toThrow(/not written by agentdeck-server.*--force/s);
    expect(fs.readFileSync(ctx.paths.unitPath, 'utf8')).toBe(foreign);
    expect(sys.calls.some((c) => c.startsWith('enable'))).toBe(false);
    // nothing was copied either
    expect(fs.existsSync(ctx.paths.runtimeRoot)).toBe(false);

    await serviceInstall(ctx, { lan: false, force: true });
    expect(parseUnit(unitText(ctx)).managed).toBe(true);
  });

  it('refuses without systemd', async () => {
    sys.available = false;
    const ctx = context(makeBundle('1.2.3'));
    await expect(serviceInstall(ctx, { lan: false })).rejects.toThrow(/systemd user services are not available/);
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(false);
  });

  it('refuses outside a packaged bundle (a git checkout keeps its own unit)', async () => {
    await expect(serviceInstall(context(undefined), { lan: false })).rejects.toThrow(/not a packaged server/);
  });

  it('complains when the service does not stay up', async () => {
    sys.crashes = true;
    await expect(serviceInstall(context(makeBundle('1.2.3')), { lan: false })).rejects.toThrow(/did not stay up.*journalctl/s);
  });
});

describe('install judges by the running process, not by the files', () => {
  let proc: FakeProc;
  const withProc = (bundle: string | undefined): ServiceContext => context(bundle, { proc });

  beforeEach(() => {
    proc = new FakeProc();
  });

  it('retries a restart that failed after the unit was written', async () => {
    const ctx = withProc(makeBundle('1.2.3'));
    sys.onStart = () => proc.startFrom(ctx);
    await serviceInstall(ctx, { lan: false });
    expect(proc.running?.env.AGENTDECK_HOST).toBe('127.0.0.1');

    sys.failRestart = true;
    await expect(serviceInstall(ctx, { lan: true })).rejects.toThrow(/systemctl --user restart failed/);
    expect(parseUnit(unitText(ctx)).lan).toBe(true); // written already, the process still listens on loopback

    sys.failRestart = false;
    sys.calls.length = 0;
    messages.length = 0;
    await serviceInstall(ctx, { lan: true });
    expect(sys.calls).toContain('restart agentdeck.service');
    expect(messages.join('\n')).toMatch(/Restarted the service \(it listens on 127\.0\.0\.1, not 0\.0\.0\.0\)/);
    expect(proc.running?.env.AGENTDECK_HOST).toBe('0.0.0.0');

    // ... and now it really is up to date
    sys.calls.length = 0;
    await serviceInstall(ctx, { lan: true });
    expect(sys.calls.some((c) => c.startsWith('restart'))).toBe(false);
  });

  it('notices a changed port or version of the running process even when the files look current', async () => {
    const ctx = withProc(makeBundle('1.0.0'));
    sys.onStart = () => proc.startFrom(ctx);
    await serviceInstall(ctx, { lan: false, port: 9100 });
    // someone changed the unit behind our back: the process runs another port
    proc.running = { exe: proc.running?.exe as string, env: { AGENTDECK_HOST: '127.0.0.1', AGENTDECK_PORT: '8000' } };
    sys.calls.length = 0;
    await serviceInstall(ctx, { lan: false });
    expect(sys.calls).toContain('restart agentdeck.service');
    expect(proc.running?.env.AGENTDECK_PORT).toBe('9100');
  });

  it('install --no-start leaves the running service alone: status shows what runs, pruning spares its directory', async () => {
    const base = withProc(undefined);
    sys.onStart = () => proc.startFrom(base);
    const install = (v: string, opts: { start?: boolean } = {}) =>
      serviceInstall({ ...base, bundleRoot: makeBundle(v) }, { lan: false, ...opts });
    const age = (v: string, minutes: number) => {
      const t = new Date(Date.now() - minutes * 60_000);
      fs.utimesSync(path.join(base.paths.runtimeRoot, v), t, t);
    };

    await install('1.0.0');
    age('1.0.0', 30);
    await install('1.1.0', { start: false });
    age('1.1.0', 20);
    await install('1.2.0', { start: false });

    // The symlink moved on, the process did not.
    expect(fs.readlinkSync(base.paths.currentLink)).toBe('1.2.0');
    expect((await serviceStatus(base)).runtimeVersion).toBe('1.0.0');
    // keep=2 alone would have removed 1.0.0 — the directory the running server loads modules from —
    // and kept 1.1.0; now the running and the current one fill the two places.
    expect(fs.readdirSync(base.paths.runtimeRoot).sort()).toEqual(['1.0.0', '1.2.0', 'current']);
    expect(messages.join('\n')).toMatch(/keeps its current version and settings until it is restarted/);

    // A normal install restarts it ("runtimeVersion != bundle" is how the desktop app finds out), then the old directory can go.
    await install('1.2.0');
    expect((await serviceStatus(base)).runtimeVersion).toBe('1.2.0');
    expect(sys.calls).toContain('restart agentdeck.service');
    expect(fs.readdirSync(base.paths.runtimeRoot)).not.toContain('1.0.0');
    expect(fs.readdirSync(base.paths.runtimeRoot)).toContain('1.2.0');
  });

  it('status falls back to the symlink when the process cannot be inspected', async () => {
    const ctx = context(makeBundle('1.2.3')); // noProc
    await serviceInstall(ctx, { lan: false });
    expect((await serviceStatus(ctx)).runtimeVersion).toBe('1.2.3');
  });

  it('ignores a service whose executable is not in the runtime tree', async () => {
    const ctx = withProc(makeBundle('1.2.3'));
    sys.onStart = () => proc.startFrom(ctx);
    await serviceInstall(ctx, { lan: false });
    proc.running = { exe: '/usr/bin/node', env: { AGENTDECK_HOST: '127.0.0.1' } };
    expect((await serviceStatus(ctx)).runtimeVersion).toBe('1.2.3'); // from the symlink
  });
});

describe('a server running outside the service', () => {
  const alive = (cmdline = ['node', '/x/app/server/dist/cli.js']): PidProbe => ({
    alive: () => true,
    cmdline: () => cmdline,
    packageName: (file) => (file === '/x/app/server/package.json' ? '@agentdeck/server' : undefined),
  });
  const withDataDir = (bundle: string | undefined, probe: PidProbe, pid = 777) => {
    const dataDir = path.join(tmp, 'server-data');
    writePidFile(dataDir, pid);
    return context(bundle, { dataDir, pidProbe: probe });
  };

  it('blocks install: a second server would fight for the port', async () => {
    const ctx = withDataDir(makeBundle('1.2.3'), alive());
    await expect(serviceInstall(ctx, { lan: false })).rejects.toThrow(/already running outside the service \(pid 777/);
    // nothing was changed
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(false);
    expect(fs.existsSync(ctx.paths.runtimeRoot)).toBe(false);
    expect(sys.calls.some((c) => c.startsWith('enable'))).toBe(false);
  });

  it('does not block --no-start, a stale pid file, or the service’s own process', async () => {
    const stale: PidProbe = { alive: () => false, cmdline: () => undefined };
    await serviceInstall(withDataDir(makeBundle('1.0.0'), alive(), 777), { lan: false, start: false });
    await serviceInstall(withDataDir(makeBundle('1.1.0'), stale), { lan: false });
    sys.active = true; // the service runs, with pid 4711 …
    await expect(serviceInstall(withDataDir(makeBundle('1.2.0'), alive(), 4711), { lan: false })).resolves.toMatchObject({ active: true });
  });

  it('blocks start, but not restart or stop', async () => {
    const ctx = withDataDir(makeBundle('1.2.3'), alive());
    await serviceInstall({ ...ctx, dataDir: undefined }, { lan: false, start: false });
    await expect(serviceControl(ctx, 'start')).rejects.toThrow(/already running outside the service/);
    expect(sys.active).toBe(false);
    await expect(serviceControl(ctx, 'stop')).resolves.toMatchObject({ active: false });
  });
});

describe('service uninstall', () => {
  it('stops, disables and removes the unit and the runtime copies', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    const status = await serviceUninstall(ctx, {});
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(false);
    expect(fs.existsSync(ctx.paths.runtimeRoot)).toBe(false);
    expect(sys.calls).toEqual(expect.arrayContaining(['stop agentdeck.service', 'disable agentdeck.service', 'daemon-reload']));
    expect(sys.calls.indexOf('stop agentdeck.service')).toBeLessThan(sys.calls.indexOf('disable agentdeck.service'));
    expect(status).toMatchObject({ installed: false, active: false, enabled: false });
  });

  it('leaves the data dir alone', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    const data = path.join(ctx.paths.dataHome, 'projects.json');
    fs.writeFileSync(data, '[]');
    await serviceUninstall(ctx, {});
    expect(fs.readFileSync(data, 'utf8')).toBe('[]');
  });

  it('keeps the runtime while the CLI runs from inside it', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false });
    const running = fs.realpathSync(ctx.paths.currentLink);
    await serviceUninstall(ctx, { runningFrom: running });
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(false);
    expect(fs.existsSync(running)).toBe(true);
  });

  it('is fine when nothing is installed', async () => {
    const ctx = context(undefined);
    await expect(serviceUninstall(ctx, {})).resolves.toMatchObject({ installed: false });
    expect(messages).toContain('The service is not installed');
  });

  it('does not remove a foreign unit without --force', async () => {
    const ctx = context(undefined);
    fs.mkdirSync(path.dirname(ctx.paths.unitPath), { recursive: true });
    fs.writeFileSync(ctx.paths.unitPath, '[Service]\nExecStart=/x\n');
    await expect(serviceUninstall(ctx, {})).rejects.toThrow(CliError);
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(true);
    expect(sys.calls.some((c) => c.startsWith('stop'))).toBe(false);
    await serviceUninstall(ctx, { force: true });
    expect(fs.existsSync(ctx.paths.unitPath)).toBe(false);
  });
});

describe('service start / stop / restart', () => {
  it('drive the unit and report the new state', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false, start: false });
    expect(await serviceControl(ctx, 'start')).toMatchObject({ active: true });
    expect(await serviceControl(ctx, 'stop')).toMatchObject({ active: false });
    expect(await serviceControl(ctx, 'restart')).toMatchObject({ active: true });
    expect(sys.calls).toEqual(expect.arrayContaining(['start agentdeck.service', 'stop agentdeck.service', 'restart agentdeck.service']));
  });

  it('need an installed unit and systemd', async () => {
    const ctx = context(undefined);
    await expect(serviceControl(ctx, 'start')).rejects.toThrow(/not installed.*service install/s);
    sys.available = false;
    await expect(serviceControl(ctx, 'stop')).rejects.toThrow(/systemd user services are not available/);
  });

  it('say so when a started service dies right away', async () => {
    const ctx = context(makeBundle('1.2.3'));
    await serviceInstall(ctx, { lan: false, start: false });
    sys.crashes = true;
    await expect(serviceControl(ctx, 'start')).rejects.toThrow(/did not stay up/);
  });

  it('work on a unit of a checkout too (stop/start/restart do no harm)', async () => {
    const ctx = context(undefined);
    fs.mkdirSync(path.dirname(ctx.paths.unitPath), { recursive: true });
    fs.writeFileSync(ctx.paths.unitPath, '[Service]\nExecStart=/x\n');
    await expect(serviceControl(ctx, 'restart')).resolves.toMatchObject({ installed: true, managed: false, active: true });
  });
});
