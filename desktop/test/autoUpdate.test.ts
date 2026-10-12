import { describe, expect, it, vi } from 'vitest';
import { runAutoUpdate, type UpdateEngine, type UpdatePrompts } from '../src/core/autoUpdate';

interface Harness {
  engine: UpdateEngine;
  prompts: UpdatePrompts;
  calls: string[];
  downloaded: () => boolean;
  prepared: () => boolean;
  installed: () => boolean;
  ignored: string[];
}

function harness(options: {
  check?: UpdateEngine['checkForUpdates'];
  download?: () => Promise<unknown>;
  available?: UpdatePrompts['available'];
  ready?: UpdatePrompts['ready'];
} = {}): Harness {
  const calls: string[] = [];
  let downloadCalled = false;
  let prepareCalled = false;
  let installCalled = false;
  const ignored: string[] = [];

  const engine: UpdateEngine = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: options.check ?? (async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.4.0' } })),
    downloadUpdate: async () => {
      downloadCalled = true;
      calls.push('download');
      return options.download ? options.download() : undefined;
    },
    quitAndInstall: () => {
      installCalled = true;
      calls.push('install');
    },
  };

  const prompts: UpdatePrompts = {
    available: options.available ?? (async () => 'install'),
    ready: options.ready ?? (async () => 'restart'),
    failed: async () => {
      calls.push('failed');
    },
  };

  return {
    engine,
    prompts,
    calls,
    downloaded: () => downloadCalled,
    prepared: () => prepareCalled,
    installed: () => installCalled,
    ignored,
  };
}

function deps(h: Harness, overrides: Partial<Parameters<typeof runAutoUpdate>[0]> = {}) {
  return {
    engine: h.engine,
    prompts: h.prompts,
    log: vi.fn(),
    rememberIgnored: (version: string) => {
      h.ignored.push(version);
    },
    prepareRestart: () => {
      h.calls.push('prepare');
    },
    ...overrides,
  };
}

describe('runAutoUpdate', () => {
  it('does nothing (and never downloads) when no update is available', async () => {
    const h = harness({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.3.0' } }) });
    await runAutoUpdate(deps(h));
    expect(h.downloaded()).toBe(false);
    expect(h.installed()).toBe(false);
  });

  it('downloads, prepares the quit and restarts on install + restart', async () => {
    const h = harness();
    await runAutoUpdate(deps(h));
    expect(h.calls).toEqual(['download', 'prepare', 'install']);
  });

  it('keeps the download for the next start when the user says later', async () => {
    const h = harness({ ready: async () => 'later' });
    await runAutoUpdate(deps(h));
    expect(h.downloaded()).toBe(true);
    expect(h.installed()).toBe(false);
  });

  it('does not download when the user defers the offer', async () => {
    const h = harness({ available: async () => 'later' });
    await runAutoUpdate(deps(h));
    expect(h.downloaded()).toBe(false);
    expect(h.installed()).toBe(false);
  });

  it('remembers a skipped version instead of downloading', async () => {
    const h = harness({ available: async () => 'ignore' });
    await runAutoUpdate(deps(h));
    expect(h.ignored).toEqual(['1.4.0']);
    expect(h.downloaded()).toBe(false);
  });

  it('stays quiet for a version that was skipped before', async () => {
    const h = harness();
    const available = vi.fn<UpdatePrompts['available']>(async () => 'install');
    await runAutoUpdate(deps(h, { ignoredVersion: '1.4.0', prompts: { ...h.prompts, available } }));
    expect(available).not.toHaveBeenCalled();
    expect(h.downloaded()).toBe(false);
  });

  it('reports a failed download and does not restart', async () => {
    const h = harness({
      download: async () => {
        throw new Error('offline');
      },
    });
    await runAutoUpdate(deps(h));
    expect(h.calls).toEqual(['download', 'failed']);
    expect(h.installed()).toBe(false);
  });

  it('stays quiet when the check itself fails', async () => {
    const h = harness({
      check: async () => {
        throw new Error('no network');
      },
    });
    const log = vi.fn();
    const available = vi.fn<UpdatePrompts['available']>(async () => 'install');
    await runAutoUpdate(deps(h, { log, prompts: { ...h.prompts, available } }));
    expect(available).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no network'));
  });

  it('turns auto-download and install-on-quit off (the flow asks first)', async () => {
    const h = harness();
    await runAutoUpdate(deps(h));
    expect(h.engine.autoDownload).toBe(false);
    expect(h.engine.autoInstallOnAppQuit).toBe(false);
  });
});
