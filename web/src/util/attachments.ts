/**
 * Attachment images for the chat.
 *
 * `Attachment.url` is relative to the server and signed for two minutes: fine
 * for a download, useless as an <img> source — the link in a stored message is
 * long expired, and the APK's page is not served by the server at all. Images
 * are therefore fetched with the device login and shown from a blob URL.
 */
import type { Attachment } from '@agentdeck/shared';
import { api, fetchBlob } from '../api/client';

/** Project (or the attachments pseudo-project) and file path behind an attachment URL. */
export function parseAttachmentUrl(url: string): { projectId: string; path: string } | null {
  const match = /\/api\/projects\/([^/?#]+)\/files\/raw\?([^#]*)/.exec(url);
  if (!match || !match[1]) return null;
  const path = new URLSearchParams(match[2] ?? '').get('path');
  if (!path) return null;
  try {
    return { projectId: decodeURIComponent(match[1]), path };
  } catch {
    return null;
  }
}

const MAX_CACHED = 80;
/** Blob URL per attachment id, oldest first. */
const cache = new Map<string, Promise<string>>();

function remember(id: string, url: Promise<string>): void {
  cache.set(id, url);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    void dropped?.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
}

/** Blob URL of an attachment, fetched once per page load. Rejects when the file cannot be loaded. */
export function attachmentBlobUrl(att: Attachment): Promise<string> {
  const hit = cache.get(att.id);
  if (hit) return hit;
  const target = parseAttachmentUrl(att.url);
  const loading = target
    ? fetchBlob(api.fileRawPath(target.projectId, target.path)).then((blob) => URL.createObjectURL(blob))
    : Promise.reject(new Error('Unknown attachment URL'));
  remember(att.id, loading);
  // A failed load is retried the next time the image is shown.
  loading.catch(() => {
    if (cache.get(att.id) === loading) cache.delete(att.id);
  });
  return loading;
}

/** A file this device just uploaded is shown from its local blob URL — no download of our own upload. */
export function rememberAttachmentUrl(id: string, blobUrl: string): void {
  remember(id, Promise.resolve(blobUrl));
}
