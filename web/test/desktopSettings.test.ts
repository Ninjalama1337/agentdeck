import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, DesktopServerStatus, DesktopSettings } from '@agentdeck/shared';
import {
  bridgeErrorMessage,
  closeActionHint,
  CLOSE_ACTIONS,
  confirmStep,
  createDesktopController,
  serviceActions,
  summarizeServer,
} from '../src/features/settings/desktopSettings';

function status(patch: Partial<DesktopServerStatus> = {}): DesktopServerStatus {
  return {
    mode: 'service',
    reachable: true,
    version: '1.2.3',
    host: '127.0.0.1',
    port: 8787,
    controllable: true,
    service: {
      systemd: true,
      installed: true,
      managed: true,
      enabled: true,
      active: true,
      unitPath: '/home/u/.config/systemd/user/agentdeck.service',
      lan: false,
    },
    ...patch,
  };
}

describe('close behavior options', () => {
  it('offers ask / background / stop with a hint each', () => {
    expect(CLOSE_ACTIONS.map((o) => o.value)).toEqual(['ask', 'background', 'stop']);
    for (const o of CLOSE_ACTIONS) expect(closeActionHint(o.value)).not.toBe('');
  });
});

describe('server summary', () => {
  it('describes every mode', () => {
    expect(summarizeServer(status())).toEqual({ label: 'Background service · running', tone: 'ok', detail: 'v1.2.3 · 127.0.0.1:8787' });
    expect(summarizeServer(status({ reachable: false })).tone).toBe('warn');
    expect(summarizeServer(status({ mode: 'detached' })).label).toBe('Started by this app · running');
    expect(summarizeServer(status({ mode: 'external', controllable: false })).label).toBe('Run by something else');
    expect(summarizeServer(status({ mode: 'stopped', reachable: false, version: undefined }))).toEqual({
      label: 'Not running',
      tone: 'warn',
      detail: '127.0.0.1:8787',
    });
  });
});

describe('service actions', () => {
  it('a running service can be restarted, stopped or removed', () => {
    expect(serviceActions(status()).map((a) => a.action)).toEqual(['restart', 'stop', 'uninstall']);
  });

  it('a stopped service can be started or removed', () => {
    expect(serviceActions(status({ mode: 'stopped', reachable: false })).map((a) => a.action)).toEqual(['start', 'uninstall']);
  });

  it('a server the app started itself can be turned into a service', () => {
    const detached = status({ mode: 'detached', service: { ...status().service!, installed: false, active: false } });
    expect(serviceActions(detached).map((a) => a.action)).toEqual(['restart', 'stop', 'install']);
  });

  it('without systemd there is no service to install or remove', () => {
    const noSystemd = status({ mode: 'detached', service: { ...status().service!, systemd: false, installed: false, active: false } });
    expect(serviceActions(noSystemd).map((a) => a.action)).toEqual(['restart', 'stop']);
    expect(serviceActions(status({ mode: 'detached', service: null })).map((a) => a.action)).toEqual(['restart', 'stop']);
  });

  it('a server the app may not control offers nothing — and neither does a missing status', () => {
    expect(serviceActions(status({ mode: 'external', controllable: false }))).toEqual([]);
    expect(serviceActions(null)).toEqual([]);
  });

  it('only stop and uninstall are confirmed', () => {
    const all = serviceActions(status());
    expect(all.filter((a) => a.confirm).map((a) => a.action)).toEqual(['stop', 'uninstall']);
    expect(all.filter((a) => a.danger).map((a) => a.action)).toEqual(['stop', 'uninstall']);
  });
});

describe('two-tap confirmation', () => {
  it('runs harmless actions at once', () => {
    expect(confirmStep(null, 'restart')).toEqual({ run: true, armed: null });
    expect(confirmStep('stop', 'restart')).toEqual({ run: true, armed: null });
  });

  it('arms stop on the first tap and runs it on the second', () => {
    const first = confirmStep(null, 'stop');
    expect(first).toEqual({ run: false, armed: 'stop' });
    expect(confirmStep(first.armed, 'stop')).toEqual({ run: true, armed: null });
  });

  it('tapping something else re-arms instead of running', () => {
    expect(confirmStep('stop', 'uninstall')).toEqual({ run: false, armed: 'uninstall' });
  });
});

describe('bridge error text', () => {
  it('strips the IPC prefix Electron adds', () => {
    expect(bridgeErrorMessage(new Error("Error invoking remote method 'service:action': Error: systemctl failed"))).toBe('systemctl failed');
    expect(bridgeErrorMessage(new Error("Error invoking remote method 'x': boom"))).toBe('boom');
  });

  it('copes with anything that can be thrown', () => {
    expect(bridgeErrorMessage(new Error('plain'))).toBe('plain');
    expect(bridgeErrorMessage('text')).toBe('text');
    expect(bridgeErrorMessage(undefined)).toBe('undefined');
    expect(bridgeErrorMessage(new Error(''))).toBe('The desktop app did not answer');
  });
});

/** A bridge whose calls are scripted by the test. */
function fakeBridge(over: Partial<DesktopBridge> = {}) {
  const listeners = new Set<(s: DesktopServerStatus) => void>();
  let settings: DesktopSettings = { closeAction: 'ask', lanAccess: false, launchAtLogin: false };
  const unsubscribe = vi.fn((l: (s: DesktopServerStatus) => void) => void listeners.delete(l));
  const bridge: DesktopBridge = {
    isDesktop: true,
    platform: 'linux',
    appVersion: '0.1.0',
    getSettings: async () => ({ ...settings }),
    setSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    getServerStatus: async () => status(),
    serviceAction: async () => status({ mode: 'stopped', reachable: false }),
    quit: async () => undefined,
    onServerStatus: (l) => {
      listeners.add(l);
      return () => unsubscribe(l);
    },
    ...over,
  };
  return { bridge, emit: (s: DesktopServerStatus) => listeners.forEach((l) => l(s)), listeners, unsubscribe };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('desktop controller', () => {
  it('loads settings and status, and follows status events', async () => {
    const { bridge, emit } = fakeBridge();
    const errors: string[] = [];
    const c = createDesktopController(bridge, (m) => errors.push(m));
    expect(c.getState()).toEqual({ settings: null, status: null, busy: null });
    await settle();
    expect(c.getState().settings).toEqual({ closeAction: 'ask', lanAccess: false, launchAtLogin: false });
    expect(c.getState().status?.mode).toBe('service');

    const seen = vi.fn();
    c.subscribe(seen);
    emit(status({ mode: 'stopped', reachable: false }));
    expect(c.getState().status?.mode).toBe('stopped');
    expect(seen).toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('applies a settings change and keeps the shell\'s answer', async () => {
    const { bridge } = fakeBridge();
    const c = createDesktopController(bridge, () => undefined);
    await settle();
    await expect(c.update({ closeAction: 'background', lanAccess: true })).resolves.toBe(true);
    expect(c.getState().settings).toEqual({ closeAction: 'background', lanAccess: true, launchAtLogin: false });
    expect(c.getState().busy).toBeNull();
  });

  it('reports a refused settings change and keeps the old value', async () => {
    const { bridge } = fakeBridge({ setSettings: () => Promise.reject(new Error("Error invoking remote method 'settings:set': Error: not writable")) });
    const errors: string[] = [];
    const c = createDesktopController(bridge, (m) => errors.push(m));
    await settle();
    await expect(c.update({ launchAtLogin: true })).resolves.toBe(false);
    expect(errors).toEqual(['Could not change the setting: not writable']);
    expect(c.getState().settings?.launchAtLogin).toBe(false);
    expect(c.getState().busy).toBeNull();
  });

  it('runs a service action and takes the status it returns', async () => {
    const { bridge } = fakeBridge();
    const c = createDesktopController(bridge, () => undefined);
    await settle();
    const done = c.run('stop');
    expect(c.getState().busy).toBe('stop');
    await expect(done).resolves.toBe(true);
    expect(c.getState().status?.mode).toBe('stopped');
    expect(c.getState().busy).toBeNull();
  });

  it('reports a failed service action — rejected or thrown — without leaving it busy', async () => {
    const rejecting = fakeBridge({ serviceAction: () => Promise.reject(new Error('systemctl failed')) });
    const errors: string[] = [];
    const a = createDesktopController(rejecting.bridge, (m) => errors.push(m));
    await settle();
    await expect(a.run('install')).resolves.toBe(false);
    expect(errors).toEqual(['Could not set up the background service: systemctl failed']);
    expect(a.getState().busy).toBeNull();

    const throwing = fakeBridge({
      serviceAction: () => {
        throw new Error('bridge broke');
      },
    });
    const b = createDesktopController(throwing.bridge, (m) => errors.push(m));
    await settle();
    await expect(b.run('restart')).resolves.toBe(false);
    expect(errors[1]).toBe('Could not restart the server: bridge broke');
  });

  it('reports a failed first load instead of leaving an unhandled rejection', async () => {
    const { bridge } = fakeBridge({
      getSettings: () => Promise.reject(new Error('no settings')),
      getServerStatus: () => Promise.reject(new Error('no status')),
    });
    const errors: string[] = [];
    const c = createDesktopController(bridge, (m) => errors.push(m));
    await settle();
    expect(errors.sort()).toEqual(['Could not read the desktop settings: no settings', 'Could not read the server status: no status']);
    expect(c.getState().settings).toBeNull();
  });

  it('survives a bridge that throws synchronously while subscribing', async () => {
    const { bridge } = fakeBridge({
      onServerStatus: () => {
        throw new Error('no events');
      },
    });
    const errors: string[] = [];
    createDesktopController(bridge, (m) => errors.push(m));
    await settle();
    expect(errors).toEqual(['Could not follow the server status: no events']);
  });

  it('stops listening and notifying after dispose', async () => {
    const { bridge, emit, unsubscribe } = fakeBridge();
    const c = createDesktopController(bridge, () => undefined);
    await settle();
    const seen = vi.fn();
    c.subscribe(seen);
    c.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    emit(status({ mode: 'stopped' }));
    expect(seen).not.toHaveBeenCalled();
    // a late answer after dispose changes nothing and does not throw
    await expect(c.update({ closeAction: 'stop' })).resolves.toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });
});
