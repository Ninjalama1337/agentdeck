import { api, fetchBlob } from '../api/client';
import { isNativePlatform } from './platform';

/**
 * Saves one project file to the device. Resolves to `'browser'` when the
 * download was handed to the system browser (APK), `'done'` otherwise.
 *
 * - APK: the Android WebView has neither the Web Share API nor a download
 *   handler for blob: URLs, so a fetched blob can't leave the app. Navigate to
 *   a signed, header-free URL instead — Capacitor passes foreign origins to
 *   the system browser, whose download manager saves the file (same route the
 *   APK update takes).
 * - Browser/PWA: share sheet where files can be shared, else a blob anchor.
 *
 * Throws on failure; a dismissed share sheet rejects with an `AbortError`.
 */
export async function downloadFile(projectId: string, path: string, name: string): Promise<'browser' | 'done'> {
  if (isNativePlatform()) {
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
