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

/** True for the rejection of a share sheet the user closed. */
export function isShareCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
