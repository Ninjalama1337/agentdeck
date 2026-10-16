import { api, fetchBlob, getApiBase, getToken } from '../api/client';
import { isNativePlatform } from './platform';
import { RELEASE_REPO } from './apkRelease';

/** Outcome of {@link downloadFile}: saved to Downloads, handed to the browser, or shared/saved by the browser itself. */
export type DownloadResult = 'saved' | 'browser' | 'done';

/**
 * Saves one project file to the device.
 *
 * - APK: the Android WebView has neither the Web Share API nor a download
 *   handler for blob: URLs, so a fetched blob can't leave the app. The native
 *   FileDownload plugin (mobile/native) lets Android's download manager fetch
 *   the file straight into the Downloads folder; `onStarted` fires once it is
 *   queued, the promise resolves when it is complete. APKs without the plugin
 *   (or below Android 10) navigate to a signed, header-free URL instead —
 *   Capacitor passes foreign origins to the system browser.
 * - Browser/PWA: share sheet where files can be shared, else a blob anchor.
 *
 * Throws on failure; a dismissed share sheet rejects with an `AbortError`.
 */
export async function downloadFile(
  projectId: string,
  path: string,
  name: string,
  onStarted?: () => void,
): Promise<DownloadResult> {
  if (isNativePlatform()) {
    const native = window.Capacitor?.Plugins?.FileDownload;
    const token = getToken();
    if (native?.download && token) {
      // Announce right away: the call itself only settles when the file is complete.
      onStarted?.();
      try {
        await native.download({
          url: `${getApiBase()}${api.fileRawPath(projectId, path)}&download=1`,
          fileName: name,
          headers: { Authorization: `Bearer ${token}` },
        });
        return 'saved';
      } catch (err) {
        const { code, message } = (err ?? {}) as { code?: string; message?: string };
        if (code === 'DOWNLOAD_FAILED') throw new Error(message || 'Download failed');
        /* could not be started natively — let the browser do it */
      }
    }
    const a = document.createElement('a');
    a.href = await api.fileDownloadUrl(projectId, path);
    a.rel = 'noopener';
    a.click();
    return 'browser';
  }
  const blob = await fetchBlob(api.fileRawPath(projectId, path));
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  if (canShare) {
    await navigator.share({ files: [file], title: name });
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 8000);
  }
  return 'done';
}

/**
 * APK only: lets Android's download manager fetch an APK (the GitHub release
 * asset) into Downloads. A plain link leaves the WebView for the system
 * browser, which opens a tab for every download and never closes it.
 *
 * Resolves `false` when the download could not be started natively (no
 * plugin, below Android 10) — the caller falls back to the link. Throws when
 * it started but failed.
 */
export async function downloadApkNatively(url: string, fileName: string, onStarted?: () => void): Promise<boolean> {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.FileDownload : undefined;
  if (!native?.download) return false;
  onStarted?.();
  try {
    await native.download({ url, fileName, mimeType: 'application/vnd.android.package-archive' });
    return true;
  } catch (err) {
    const { code, message } = (err ?? {}) as { code?: string; message?: string };
    if (code === 'DOWNLOAD_FAILED') throw new Error(message || 'Download failed');
    return false;
  }
}

/**
 * APK only: downloads the APK at `url` (the GitHub release asset) and opens
 * Android's installer on it ("Update this app?"). `onProgress` gets 0..1 while
 * it loads.
 *
 * Resolves `false` when this APK cannot do it (built before the ApkInstall
 * plugin, below Android 7) — the caller falls back to a plain download.
 * Throws when the download or the installer failed.
 */
export async function installApkUpdate(url: string, onProgress?: (fraction: number) => void): Promise<boolean> {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.ApkInstall : undefined;
  if (!native?.install) return false;
  // The bridge hands back a listener handle — directly or as a promise,
  // depending on how the plugin is reached; `await` takes either.
  let listener: { remove?: () => unknown } | undefined;
  try {
    listener = (await (native.addListener as ((...args: unknown[]) => unknown) | undefined)?.(
      'progress',
      (e: unknown) => onProgress?.((e as { fraction?: number }).fraction ?? 0),
    )) as typeof listener;
  } catch {
    /* no progress events — the update itself still works */
  }
  try {
    await native.install({ url });
    return true;
  } catch (err) {
    const { code, message } = (err ?? {}) as { code?: string; message?: string };
    if (code === 'DOWNLOAD_FAILED' || code === 'INSTALL_FAILED') throw new Error(message || 'Update failed');
    return false;
  } finally {
    try {
      void listener?.remove?.();
    } catch {
      /* already gone */
    }
  }
}

/** True when this app can hand an APK straight to Android's installer (see {@link installApkFile}). */
export function canInstallApks(): boolean {
  return isNativePlatform() && typeof window.Capacitor?.Plugins?.ApkInstall?.install === 'function';
}

/**
 * APK only: downloads an `.apk` from the project and opens Android's installer
 * on it — install or update without a detour through Downloads and a file
 * manager. Goes through a signed URL: the plugin sends no auth header.
 *
 * Resolves `false` when this APK cannot do it; throws like {@link installApkUpdate}.
 */
export async function installApkFile(
  projectId: string,
  path: string,
  onProgress?: (fraction: number) => void,
): Promise<boolean> {
  if (!canInstallApks()) return false;
  return installApkUpdate(await api.fileDownloadUrl(projectId, path), onProgress);
}

/**
 * APK only: tells the native background update check (UpdateCheckWorker.java)
 * which repo publishes the releases. Older APKs lack the method — fine.
 */
export function configureNativeUpdateCheck(): void {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.ApkInstall : undefined;
  void native?.configureUpdates?.({ repo: RELEASE_REPO })?.catch?.(() => undefined);
}

/**
 * APK only: the versionName Android has installed, or null (browser, or an
 * APK built before the method existed).
 */
export async function installedApkVersion(): Promise<string | null> {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.ApkInstall : undefined;
  try {
    const res = (await native?.version?.()) as { version?: unknown } | undefined;
    return typeof res?.version === 'string' ? res.version : null;
  } catch {
    return null;
  }
}

/** True for the rejection of a share sheet the user closed. */
export function isShareCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
