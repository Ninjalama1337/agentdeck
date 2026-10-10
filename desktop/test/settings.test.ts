import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_SETTINGS } from '../src/core/contract';
import { normalizeSettings, normalizeState, sanitizeSettingsPatch, SettingsStore, StateStore } from '../src/core/settings';
import { SettingsService } from '../src/core/settingsService';
import { MemFs } from './helpers/memFs';

describe('settings validation', () => {
  it('uses the contract defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(normalizeSettings({})).toEqual({ closeAction: 'ask', lanAccess: false, launchAtLogin: false });
  });

  it('keeps valid values and drops the rest', () => {
    expect(normalizeSettings({ closeAction: 'stop', lanAccess: true, launchAtLogin: true, extra: 1 })).toEqual({
      closeAction: 'stop', lanAccess: true, launchAtLogin: true,
    });
    expect(normalizeSettings({ closeAction: 'explode', lanAccess: 'yes', launchAtLogin: 1 })).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(sanitizeSettingsPatch(null)).toEqual({});
    expect(sanitizeSettingsPatch({ closeAction: 'background', foo: 'bar' })).toEqual({ closeAction: 'background' });
  });
});

describe('SettingsStore', () => {
  it('starts with defaults when the file is missing or corrupt', async () => {
    expect(await new SettingsStore(new MemFs(), '/s.json').load()).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(await new SettingsStore(new MemFs({ '/s.json': '{broken' }), '/s.json').load()).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it('persists updates atomically and reads them back', async () => {
    const fs = new MemFs();
    const store = new SettingsStore(fs, '/cfg/s.json');
    await store.load();
    expect(await store.update({ closeAction: 'background' })).toEqual({ closeAction: 'background', lanAccess: false, launchAtLogin: false });
    expect(JSON.parse((await fs.readFile('/cfg/s.json')).trim())).toMatchObject({ closeAction: 'background' });
    expect([...fs.files.keys()].some((f) => f.includes('.tmp-'))).toBe(false);
    expect(fs.files.get('/cfg/s.json')?.mode).toBe(0o600);
    expect(await new SettingsStore(fs, '/cfg/s.json').load()).toMatchObject({ closeAction: 'background' });
  });

  it('ignores invalid patches', async () => {
    const store = new SettingsStore(new MemFs(), '/s.json');
    await store.load();
    expect(await store.update({ closeAction: 'nope' as never })).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });
});

describe('StateStore', () => {
  it('remembers the declined service offer and the ignored update', async () => {
    const fs = new MemFs();
    const store = new StateStore(fs, '/state.json');
    expect(await store.load()).toEqual({ serviceDeclined: false });
    await store.update({ serviceDeclined: true });
    await store.update({ updateIgnored: '1.2.3' });
    expect(await new StateStore(fs, '/state.json').load()).toEqual({ serviceDeclined: true, updateIgnored: '1.2.3' });
    expect(normalizeState({ serviceDeclined: 'x', updateIgnored: '' })).toEqual({ serviceDeclined: false });
  });
});

function service(options: { lan?: boolean | null; autostart?: boolean; failLan?: boolean } = {}) {
  const calls: string[] = [];
  const stored = { ...DEFAULT_DESKTOP_SETTINGS };
  let autostart = options.autostart ?? false;
  const svc = new SettingsService({
    store: {
      get: () => ({ ...stored }),
      update: async (patch) => {
        Object.assign(stored, patch);
        calls.push(`store:${JSON.stringify(patch)}`);
        return { ...stored };
      },
    },
    autostart: {
      isEnabled: async () => autostart,
      set: async (enabled) => {
        autostart = enabled;
        calls.push(`autostart:${enabled}`);
      },
    },
    server: {
      serviceLan: () => options.lan ?? null,
      applyLanAccess: async (lan) => {
        calls.push(`lan:${lan}`);
        if (options.failLan) throw new Error('install failed');
      },
    },
  });
  return { svc, calls };
}

describe('SettingsService', () => {
  it('reports launch-at-login from the autostart entry and LAN from the installed service', async () => {
    expect(await service({ autostart: true, lan: true }).svc.get()).toEqual({ closeAction: 'ask', lanAccess: true, launchAtLogin: true });
    expect(await service({ lan: null }).svc.get()).toMatchObject({ lanAccess: false, launchAtLogin: false });
  });

  it('applies side effects for changed values only', async () => {
    const { svc, calls } = service();
    const result = await svc.set({ launchAtLogin: true, lanAccess: true, closeAction: 'background' });
    expect(calls).toEqual(['autostart:true', 'lan:true', 'store:{"closeAction":"background","lanAccess":true,"launchAtLogin":true}']);
    expect(result.launchAtLogin).toBe(true);
    const again = service({ autostart: true });
    await again.svc.set({ launchAtLogin: true });
    expect(again.calls.filter((c) => c.startsWith('autostart'))).toEqual([]);
  });

  it('keeps the old setting when applying it fails', async () => {
    const { svc, calls } = service({ failLan: true });
    await expect(svc.set({ lanAccess: true })).rejects.toThrow('install failed');
    expect(calls.some((c) => c.startsWith('store'))).toBe(false);
  });

  it('filters untrusted patches', async () => {
    const { svc, calls } = service();
    await svc.set({ closeAction: 'rm -rf', unknown: true });
    expect(calls).toEqual(['store:{}']);
  });
});
