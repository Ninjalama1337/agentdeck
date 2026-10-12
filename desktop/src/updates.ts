import { autoUpdater } from 'electron-updater';
import { updateAvailable, updateFailed, updateReady } from './dialogs';
import { runAutoUpdate, type UpdateEngine, type UpdatePrompts } from './core/autoUpdate';
import type { BrowserWindow } from 'electron';
import type { StateStore } from './core/settings';

/**
 * Self-update of the desktop app (AppImage and deb). `electron-updater` reads
 * `app-update.yml`/`package-type` from the bundle, checks the latest GitHub
 * release, and installs it per package type: the AppImage is replaced in place,
 * the deb runs the package manager (a polkit/sudo prompt). The bundled server
 * follows automatically — the new app stages its runtime on first start.
 *
 * Runs only in a packaged app; a failed or offline check stays quiet.
 */
export interface UpdateCheckOptions {
  state: StateStore;
  window(): BrowserWindow | null;
  log(message: string): void;
  /** Flush state and mark the quit as an update restart (see main.ts). */
  prepareRestart(): Promise<void> | void;
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<void> {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: options.log,
    warn: options.log,
    error: options.log,
    debug: options.log,
  };

  const prompts: UpdatePrompts = {
    available: (version) => updateAvailable(options.window(), version),
    ready: (version) => updateReady(options.window(), version),
    failed: (message) => updateFailed(options.window(), message),
  };

  await runAutoUpdate({
    engine: autoUpdater as unknown as UpdateEngine,
    prompts,
    log: options.log,
    ignoredVersion: options.state.get().updateIgnored,
    rememberIgnored: async (version) => {
      await options.state.update({ updateIgnored: version });
    },
    prepareRestart: options.prepareRestart,
  });
}
