import { api, fetchBlob, getApiBase, getToken } from '../api/client';
import { isNativePlatform } from './platform';

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
 * APK only: lets Android's download manager fetch the server's latest app
 * build into Downloads. A plain link leaves the WebView for the system
 * browser, which opens a tab for every download and never closes it.
 *
 * Resolves `false` when the download could not be started natively (no
 * plugin, below Android 10) — the caller falls back to the link. Throws when
 * it started but failed.
 */
export async function downloadApkNatively(fileName: string, onStarted?: () => void): Promise<boolean> {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.FileDownload : undefined;
  if (!native?.download) return false;
  onStarted?.();
  try {
    await native.download({ url: api.apkLatestUrl(), fileName, mimeType: 'application/vnd.android.package-archive' });
    return true;
  } catch (err) {
    const { code, message } = (err ?? {}) as { code?: string; message?: string };
    if (code === 'DOWNLOAD_FAILED') throw new Error(message || 'Download failed');
    return false;
  }
}

/**
 * APK only: downloads the server's latest app build and opens Android's
 * installer on it ("Update this app?"). `onProgress` gets 0..1 while it loads.
 *
 * Resolves `false` when this APK cannot do it (built before the ApkInstall
 * plugin, below Android 7) — the caller falls back to a plain download.
 * Throws when the download or the installer failed.
 */
export async function installApkUpdate(onProgress?: (fraction: number) => void): Promise<boolean> {
  const native = isNativePlatform() ? window.Capacitor?.Plugins?.ApkInstall : undefined;
  if (!native?.install) return false;
  const listener = (await native
    .addListener?.('progress', (e: unknown) => onProgress?.((e as { fraction?: number }).fraction ?? 0))
    ?.catch(() => undefined)) as { remove?: () => unknown } | undefined;
  try {
    await native.install({ url: api.apkLatestUrl() });
    return true;
  } catch (err) {
    const { code, message } = (err ?? {}) as { code?: string; message?: string };
    if (code === 'DOWNLOAD_FAILED' || code === 'INSTALL_FAILED') throw new Error(message || 'Update failed');
    return false;
  } finally {
    void listener?.remove?.();
  }
}

/** True for the rejection of a share sheet the user closed. */
export function isShareCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
