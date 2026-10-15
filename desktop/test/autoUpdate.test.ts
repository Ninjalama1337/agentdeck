import { describe, expect, it, vi } from 'vitest';
import { runAutoUpdate, scheduleUpdateChecks, type UpdateEngine, type UpdatePrompts } from '../src/core/autoUpdate';

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

describe('periodic checks', () => {
  it('offers a version once per run, a newer one again', async () => {
    const offered = new Set<string>();
    let version = '1.4.0';
    const asked: string[] = [];
    const run = () =>
      runAutoUpdate({
        engine: {
          autoDownload: true,
          autoInstallOnAppQuit: true,
          checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version } }),
          downloadUpdate: async () => undefined,
          quitAndInstall: () => undefined,
        },
        prompts: {
          available: async (v) => {
            asked.push(v);
            return 'later';
          },
          ready: async () => 'later',
          failed: async () => undefined,
        },
        log: () => undefined,
        rememberIgnored: () => undefined,
        prepareRestart: () => undefined,
        offered,
      });
    await run();
    await run();
    version = '1.5.0';
    await run();
    expect(asked).toEqual(['1.4.0', '1.5.0']);
  });

  it('checks after the first delay and then on every interval, never twice at once', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | null = null;
      const check = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
      scheduleUpdateChecks(check, { firstDelayMs: 1000, intervalMs: 5000 });
      expect(check).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(1);
      // The first pass still waits on a dialog: the interval skips.
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledTimes(1);
      release!();
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
