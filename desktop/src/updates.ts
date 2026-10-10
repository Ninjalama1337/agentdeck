import { net, shell, type BrowserWindow } from 'electron';
import { updateNotice } from './dialogs';
import { fetchLatestRelease, isUpdateWorthNoticing } from './core/updateCheck';
import type { StateStore } from './core/settings';

/**
 * Tells the user when a newer release exists (a notice with a link — the same for
 * AppImage and deb). The app does not replace itself: the server it carries is
 * updated by the new app on its first start.
 */
export async function checkForUpdate(options: {
  currentVersion: string;
  state: StateStore;
  window(): BrowserWindow | null;
  log(message: string): void;
}): Promise<void> {
  const latest = await fetchLatestRelease((url, init) => net.fetch(url, init));
  if (!latest) return;
  if (!isUpdateWorthNoticing(options.currentVersion, latest, options.state.get().updateIgnored)) return;
  options.log(`release ${latest.version} is available (running ${options.currentVersion})`);
  const answer = await updateNotice(options.window(), latest.version);
  if (answer === 'open') await shell.openExternal(latest.url);
  else if (answer === 'ignore') await options.state.update({ updateIgnored: latest.version });
}
