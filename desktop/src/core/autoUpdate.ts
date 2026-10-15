/**
 * The self-update flow, free of Electron: run exactly one check, ask the user
 * before downloading, then restart into the new version. `electron-updater`
 * picks the right mechanism per package (AppImage replaces the file, deb runs
 * the package manager) — this only decides *whether* and *when*.
 *
 * Injectable engine + prompts keep the whole flow unit-testable.
 */

/** The slice of electron-updater's AppUpdater this flow uses. */
export interface UpdateEngine {
  /** Download as soon as an update is found (we keep this off — we ask first). */
  autoDownload: boolean;
  /** Install a downloaded update on quit without asking (off — we restart explicitly). */
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  /** Close the app and install the already-downloaded update. */
  quitAndInstall(): void;
}

export interface UpdatePrompts {
  /** Before download: install now, ask again next start, or never for this version. */
  available(version: string): Promise<'install' | 'later' | 'ignore'>;
  /** After download: restart now, or keep it for the next start. */
  ready(version: string): Promise<'restart' | 'later'>;
  /** A chosen install could not be prepared (offline, no permission). */
  failed(message: string): Promise<void>;
}

export interface AutoUpdateDeps {
  engine: UpdateEngine;
  prompts: UpdatePrompts;
  log(message: string): void;
  /** Version the user chose to skip (StateStore.updateIgnored). */
  ignoredVersion?: string;
  rememberIgnored(version: string): void | Promise<void>;
  /**
   * Versions already offered while this app runs: a "Later" holds until the
   * next start or a newer release, so the periodic check does not nag.
   */
  offered?: Set<string>;
  /** Runs before the app quits to install: flush state and mark the quit as ours. */
  prepareRestart(): Promise<void> | void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One update pass. Never throws — a failed or unavailable check stays quiet
 * (the desktop check is not something the user must act on).
 */
export async function runAutoUpdate(deps: AutoUpdateDeps): Promise<void> {
  const { engine, prompts, log } = deps;
  engine.autoDownload = false;
  engine.autoInstallOnAppQuit = false;

  let result: Awaited<ReturnType<UpdateEngine['checkForUpdates']>>;
  try {
    result = await engine.checkForUpdates();
  } catch (err) {
    log(`update check failed: ${messageOf(err)}`);
    return;
  }
  if (!result?.isUpdateAvailable) return;

  const version = result.updateInfo.version;
  if (deps.ignoredVersion === version) {
    log(`update ${version} is ignored`);
    return;
  }

  if (deps.offered?.has(version)) {
    log(`update ${version} was already offered`);
    return;
  }
  deps.offered?.add(version);

  const answer = await prompts.available(version);
  if (answer === 'ignore') {
    await deps.rememberIgnored(version);
    return;
  }
  if (answer !== 'install') return;

  try {
    await engine.downloadUpdate();
  } catch (err) {
    const message = messageOf(err);
    log(`update download failed: ${message}`);
    await prompts.failed(message);
    return;
  }

  if ((await prompts.ready(version)) !== 'restart') return;
  await deps.prepareRestart();
  engine.quitAndInstall();
}

/** How often a running app looks for a release (same cadence as the Android check). */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Runs `check` once after `firstDelayMs`, then every `intervalMs` — the app
 * mostly lives in the background for days, a check at start alone never sees
 * a release. A pass still running (a dialog is open) is not started twice.
 */
export function scheduleUpdateChecks(
  check: () => Promise<void>,
  options: {
    firstDelayMs: number;
    intervalMs?: number;
    timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval };
  },
): void {
  const timers = options.timers ?? { setTimeout, setInterval };
  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    void check()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  timers.setTimeout(pass, options.firstDelayMs).unref?.();
  timers.setInterval(pass, options.intervalMs ?? UPDATE_INTERVAL_MS).unref?.();
}
