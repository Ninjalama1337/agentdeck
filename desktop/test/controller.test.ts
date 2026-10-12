import { describe, expect, it } from 'vitest';
import { noUnit, World } from './helpers/world';

const managed = (patch: object = {}) => ({ ...noUnit, installed: true, managed: true, enabled: true, ...patch });

describe('ensureRunning', () => {
  it('leaves a running service alone', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck', version: '2.0.0' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('service');
    expect(w.calls.filter((c) => c !== 'status')).toEqual([]);
  });

  it('updates the service runtime when the app brought a newer server', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '1.9.0', lan: true });
    w.probe = { state: 'agentdeck', version: '1.9.0' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok).toBe(true);
    // keeps the unit's current LAN binding
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['install --lan --port 4317']);
  });

  it('never downgrades the service to an older bundle', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '3.0.0' });
    w.probe = { state: 'agentdeck', version: '3.0.0' };
    await w.controller.ensureRunning({ interactive: true });
    expect(w.calls.some((c) => c.startsWith('install'))).toBe(false);
  });

  it('only updates the runtime from the bundled CLI, not from an env override', async () => {
    const w = new World();
    (w.controller as unknown as { deps: { cliSource: string } }).deps.cliSource = 'env';
    w.service = managed({ active: true, runtimeVersion: '1.0.0' });
    w.probe = { state: 'agentdeck', version: '1.0.0' };
    await w.controller.ensureRunning({ interactive: true });
    expect(w.calls.some((c) => c.startsWith('install'))).toBe(false);
  });

  it('starts an installed but stopped unit', async () => {
    const w = new World();
    w.service = managed({ runtimeVersion: '2.0.0' });
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('service');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['start']);
  });

  it('installs instead of starting when the stopped unit runs an old runtime', async () => {
    const w = new World();
    w.service = managed({ runtimeVersion: '1.0.0' });
    await w.controller.ensureRunning({ interactive: true });
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['install --port 4317']);
  });

  it('offers the service on first start and installs it with the LAN setting', async () => {
    const w = new World();
    w.settings = { ...w.settings, lanAccess: true };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('service');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['offer', 'install --lan --port 4317']);
  });

  it('remembers a "no" and runs the server detached', async () => {
    const w = new World();
    w.offer = false;
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('detached');
    expect(w.state.serviceDeclined).toBe(true);
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['offer', 'detached-start host=127.0.0.1 port=4317']);

    // the next start does not ask again
    const w2 = new World();
    w2.state = { serviceDeclined: true };
    await w2.controller.ensureRunning({ interactive: true });
    expect(w2.calls).not.toContain('offer');
  });

  it('never prompts on a hidden (login) start', async () => {
    const w = new World();
    const result = await w.controller.ensureRunning({ interactive: false });
    expect(w.calls).not.toContain('offer');
    expect(result.ok && result.state.mode).toBe('detached');
  });

  it('goes detached without systemd', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('detached');
    expect(w.calls).not.toContain('offer');
  });

  it('goes detached when the status cannot be read at all', async () => {
    const w = new World();
    w.service = null;
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('detached');
  });

  it('does not touch a unit the CLI did not write, and starts detached', async () => {
    const w = new World();
    w.service = { ...noUnit, installed: true, managed: false };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state.mode).toBe('detached');
    expect(w.calls.some((c) => c.startsWith('install') || c === 'start')).toBe(false);
  });

  it('binds detached servers to all interfaces only with LAN access', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.settings = { ...w.settings, lanAccess: true };
    await w.controller.ensureRunning({ interactive: true });
    expect(w.calls).toContain('detached-start host=0.0.0.0 port=4317');
  });

  it('treats a server it did not start as external and just connects', async () => {
    const w = new World();
    w.probe = { state: 'agentdeck', version: '2.0.0' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok && result.state).toMatchObject({ mode: 'external', controllable: false });
    expect(w.calls.filter((c) => c !== 'status')).toEqual([]);
  });

  it('refuses to move to another port when a stranger holds it', async () => {
    const w = new World();
    w.probe = { state: 'foreign' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result).toMatchObject({ ok: false, kind: 'port-busy' });
    expect(w.calls.filter((c) => c !== 'status')).toEqual([]);
  });

  it('reports a server that does not come up, with where to look', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.startsFail = true;
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect(!result.ok && result.message).toContain('/state/server.log');
  });

  it('turns a CLI failure into a failed result', async () => {
    const w = new World();
    w.cli.serviceInstall = async () => {
      throw new Error('unit exists — use --force');
    };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result).toMatchObject({ ok: false, kind: 'failed', message: 'unit exists — use --force' });
  });
});

describe('serviceAction', () => {
  it('stops and starts a service', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    expect((await w.controller.serviceAction('stop')).mode).toBe('stopped');
    expect((await w.controller.serviceAction('start')).mode).toBe('service');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['stop', 'start']);
  });

  it('restarts a running service', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    await w.controller.serviceAction('restart');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['restart']);
  });

  it('start without a unit starts detached', async () => {
    const w = new World();
    const status = await w.controller.serviceAction('start');
    expect(status.mode).toBe('detached');
  });

  it('install takes over from a detached server', async () => {
    const w = new World();
    w.probe = { state: 'agentdeck' };
    w.detachedOurs = true;
    const status = await w.controller.serviceAction('install');
    expect(status.mode).toBe('service');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['detached-stop', 'install --port 4317']);
  });

  it('install without systemd is an error, not a crash', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    await expect(w.controller.serviceAction('install')).rejects.toThrow(/systemd/);
  });

  it('install and start hand a detached server over first (the CLI refuses while server.pid is taken)', async () => {
    const w = new World();
    w.service = managed({ runtimeVersion: '2.0.0' });
    w.detachedOurs = true; // ours is alive but not answering (still starting)
    await w.controller.serviceAction('start');
    expect(w.calls.filter((c) => c !== 'status').slice(0, 2)).toEqual(['detached-stop', 'start']);
  });

  it('uninstall removes the unit and leaves the server stopped', async () => {
    const w = new World();
    w.service = managed({ active: true });
    w.probe = { state: 'agentdeck' };
    const status = await w.controller.serviceAction('uninstall');
    expect(status.mode).toBe('stopped');
    expect(status.service?.installed).toBe(false);
  });

  it('stops a detached server but refuses an external one', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.probe = { state: 'agentdeck' };
    await expect(w.controller.serviceAction('stop')).rejects.toThrow(/not started by AgentDeck/);
    w.detachedOurs = true;
    expect((await w.controller.serviceAction('stop')).mode).toBe('stopped');
    expect(w.calls).toContain('detached-stop');
  });

  it('restarts a detached server by stopping and starting it', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.probe = { state: 'agentdeck' };
    w.detachedOurs = true;
    await w.controller.serviceAction('restart');
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['detached-stop', 'detached-start host=127.0.0.1 port=4317']);
  });

  it('actions run one at a time', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    await Promise.all([w.controller.serviceAction('stop'), w.controller.serviceAction('start')]);
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['stop', 'start']);
  });
});

describe('stopForQuit', () => {
  it('stops a service and a detached server, leaves an external one running', async () => {
    const svc = new World();
    svc.service = managed({ active: true });
    svc.probe = { state: 'agentdeck' };
    await svc.controller.stopForQuit();
    expect(svc.calls).toContain('stop');

    const det = new World();
    det.service = { ...noUnit, systemd: false };
    det.probe = { state: 'agentdeck' };
    det.detachedOurs = true;
    await det.controller.stopForQuit();
    expect(det.calls).toContain('detached-stop');

    const ext = new World();
    ext.probe = { state: 'agentdeck' };
    await ext.controller.stopForQuit();
    expect(ext.calls.filter((c) => c !== 'status')).toEqual([]);
  });
});

describe('install command line', () => {
  it('always names the port, and --lan only when LAN access is on', async () => {
    const w = new World();
    w.info = { ...w.info, port: 4401 };
    await w.controller.serviceAction('install');
    expect(w.calls).toContain('install --port 4401');
    const lan = new World();
    lan.settings = { ...lan.settings, lanAccess: true };
    await lan.controller.serviceAction('install');
    expect(lan.calls).toContain('install --lan --port 4317');
  });

  it('a detached server gets bind address and port explicitly', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.info = { ...w.info, port: 4402 };
    await w.controller.ensureRunning({ interactive: false });
    expect(w.calls).toContain('detached-start host=127.0.0.1 port=4402');
  });
});

describe('applyLanAccess', () => {
  it('rewrites the unit once — the CLI restarts a running unit whose file changed, no second restart', async () => {
    const w = new World();
    w.service = managed({ active: true, lan: false, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    await w.controller.applyLanAccess(true);
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['install --lan --port 4317']);
  });

  it('refuses a server the app does not control instead of pretending the setting applied', async () => {
    const external = new World();
    external.probe = { state: 'agentdeck' };
    await expect(external.controller.applyLanAccess(true)).rejects.toThrow(/not started by AgentDeck/);

    const foreignUnit = new World();
    foreignUnit.service = { ...noUnit, installed: true, managed: false, active: true };
    foreignUnit.probe = { state: 'agentdeck' };
    await expect(foreignUnit.controller.applyLanAccess(true)).rejects.toThrow(/not set up by AgentDeck/);
    expect(foreignUnit.calls.some((c) => c.startsWith('install'))).toBe(false);
  });

  it('only stores the setting when nothing runs (it applies at the next start)', async () => {
    const w = new World();
    await w.controller.applyLanAccess(true);
    expect(w.calls.filter((c) => c !== 'status')).toEqual([]);
  });

  it('puts the old binding back when the detached server will not start with the new one', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.probe = { state: 'agentdeck' };
    w.detachedOurs = true;
    w.detachedStartFailsFor = '0.0.0.0';
    await expect(w.controller.applyLanAccess(true)).rejects.toThrow('spawn failed');
    expect(w.calls.filter((c) => c !== 'status')).toEqual([
      'detached-stop',
      'detached-start host=0.0.0.0 port=4317',
      'detached-start host=127.0.0.1 port=4317',
    ]);
    expect((await w.controller.refresh(true)).mode).toBe('detached');
    expect(w.controller.last()?.lan).toBe(false);
  });

  it('does nothing when the unit is already bound that way', async () => {
    const w = new World();
    w.service = managed({ active: true, lan: true });
    w.probe = { state: 'agentdeck' };
    await w.controller.applyLanAccess(true);
    expect(w.calls.filter((c) => c !== 'status')).toEqual([]);
  });

  it('announces the new binding to the window', async () => {
    const w = new World();
    w.service = managed({ active: true, lan: false, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    const seen: Array<boolean | undefined> = [];
    await w.controller.refresh();
    w.controller.onChange((s) => seen.push(s.service?.lan));
    await w.controller.applyLanAccess(true);
    expect(seen.at(-1)).toBe(true);
  });

  it('restarts a detached server with the new bind address', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.probe = { state: 'agentdeck' };
    w.detachedOurs = true;
    // the setting itself is stored only after the change was applied — the new value must come from the call
    expect(w.settings.lanAccess).toBe(false);
    await w.controller.applyLanAccess(true);
    expect(w.calls.filter((c) => c !== 'status')).toEqual(['detached-stop', 'detached-start host=0.0.0.0 port=4317']);
  });
});

describe('status events', () => {
  it('notifies listeners only when something changed', async () => {
    const w = new World();
    const seen: string[] = [];
    w.controller.onChange((s) => seen.push(s.mode));
    await w.controller.refresh();
    await w.controller.refresh();
    w.probe = { state: 'agentdeck' };
    await w.controller.refresh();
    expect(seen).toEqual(['stopped', 'external']);
  });
});

describe('a server that does not answer in time', () => {
  it('is asked again after a short pause before it counts as busy', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    const answers = [{ state: 'unresponsive' as const }, { state: 'agentdeck' as const }];
    let asked = 0;
    (w.controller as unknown as { deps: { probe: () => Promise<unknown> } }).deps.probe = async () => {
      asked += 1;
      return answers.shift() ?? { state: 'agentdeck' };
    };
    const state = await w.controller.refresh(true);
    expect(asked).toBe(2);
    expect(state).toMatchObject({ reachable: true, mode: 'service', holder: 'agentdeck' });
  });

  it('keeps its last known state for the close decision — a busy service must not look stopped', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    await w.controller.refresh(true);
    w.probe = { state: 'unresponsive' };
    const state = await w.controller.stateForDecision();
    expect(state).toMatchObject({ mode: 'service', controllable: true });
    // closeAction=stop therefore still stops it
    await w.controller.stopForQuit();
    expect(w.calls).toContain('stop');
  });

  it('a busy detached server of ours stays controllable and is waited for, not started twice', async () => {
    const w = new World();
    w.service = { ...noUnit, systemd: false };
    w.probe = { state: 'unresponsive' };
    w.detachedOurs = true;
    const state = await w.controller.refresh(true);
    expect(state).toMatchObject({ mode: 'detached', controllable: true, reachable: false, portConflict: false });
    w.probe = { state: 'agentdeck' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result.ok).toBe(true);
    expect(w.calls.some((c) => c.startsWith('detached-start'))).toBe(false);
  });

  it('at startup an unknown program that does not answer is not called "AgentDeck"', async () => {
    const w = new World();
    w.probe = { state: 'unresponsive' };
    const result = await w.controller.ensureRunning({ interactive: true });
    expect(result).toMatchObject({ ok: false, kind: 'unresponsive' });
  });
});

describe('identify (who holds the port)', () => {
  it('uses the last look while it is fresh, a new one when it is old', async () => {
    const w = new World();
    w.probe = { state: 'agentdeck' };
    await w.controller.refresh(true);
    w.probe = { state: 'foreign' }; // swapped just now …
    expect(await w.controller.identify(5000)).toBe('agentdeck'); // … but the look is young
    w.clock += 6000;
    expect(await w.controller.identify(5000)).toBe('foreign'); // old: looks again
  });

  it('identifies a stranger, an empty port and a failing CLI', async () => {
    const w = new World();
    expect(await w.controller.identify()).toBe('none');
    w.probe = { state: 'foreign' };
    expect(await w.controller.identify(0)).toBe('foreign');
    const broken = new World();
    broken.info = undefined as never; // the CLI answers nothing usable
    broken.cli.info = async () => {
      throw new Error('cli broken');
    };
    expect(await broken.controller.identify()).toBe('unknown');
  });
});

describe('the unit status is not asked for on every look', () => {
  it('caches it for 30 s, but looks again when the port changes hands', async () => {
    const w = new World();
    w.service = managed({ active: true, runtimeVersion: '2.0.0' });
    w.probe = { state: 'agentdeck' };
    await w.controller.refresh();
    await w.controller.refresh();
    expect(w.calls.filter((c) => c === 'status')).toHaveLength(1);
    w.clock += 31_000;
    await w.controller.refresh();
    expect(w.calls.filter((c) => c === 'status')).toHaveLength(2);
    w.probe = { state: 'closed' }; // changed holder -> fresh look at the unit
    await w.controller.refresh();
    expect(w.calls.filter((c) => c === 'status')).toHaveLength(3);
  });
});
