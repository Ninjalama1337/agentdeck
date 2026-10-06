/**
 * AgentDeck as a share target. Text, links, images and files another app
 * shares arrive here — in the APK from the native ShareTarget plugin
 * (mobile/native/ShareTargetPlugin.java), in the installed PWA through the
 * service worker (sw.ts stashes them in the Cache API) — and are offered to
 * the user, who picks the chat they go to (features/share/ShareSheet.tsx).
 */
import { isNativePlatform } from './platform';

export interface IncomingShare {
  text: string;
  files: File[];
}

interface NativeSharedFile {
  index: number;
  name: string;
  mime: string;
  size: number;
}

interface NativeShare {
  text?: string;
  files?: NativeSharedFile[];
}

function plugin() {
  return window.Capacitor?.Plugins?.ShareTarget as unknown as
    | {
        addListener?: (ev: string, cb: (e: NativeShare) => void) => unknown;
        read?: (o: { index: number }) => Promise<{ data: string }>;
      }
    | undefined;
}

function fromBase64(data: string, type: string): Blob {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** A file name the server and the agent can work with, whatever the sharing app called it. */
export function shareFileName(name: string, mime: string, index: number): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  const base = clean || `shared-${index + 1}`;
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;
  const ext = /^[a-z]+\/([a-z0-9.+-]+)$/i.exec(mime)?.[1]?.replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return ext && ext.length <= 8 && ext !== 'octet-stream' ? `${base}.${ext}` : base;
}

/**
 * APK: reports every share another app sends, including the one that started
 * the app. `onProblem` gets a readable line when a file could not be taken over.
 */
export function listenForNativeShares(onShare: (share: IncomingShare) => void, onProblem: (message: string) => void): void {
  if (!isNativePlatform()) return;
  const native = plugin();
  native?.addListener?.('shared', (event) => {
    void (async () => {
      const files: File[] = [];
      for (const meta of event.files ?? []) {
        try {
          const res = await native.read?.({ index: meta.index });
          if (!res?.data) continue;
          files.push(new File([fromBase64(res.data, meta.mime)], shareFileName(meta.name, meta.mime, meta.index), { type: meta.mime }));
        } catch (err) {
          onProblem(`${meta.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
        }
      }
      const text = (event.text ?? '').trim();
      if (text || files.length) onShare({ text, files });
    })();
  });
}

const SHARE_CACHE = 'agentdeck-share';

/** PWA: what the service worker stashed for `/?shared=1` — taken once. */
export async function takeStashedShare(): Promise<IncomingShare | null> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files: File[] = [];
    const image = await cache.match('/__shared__');
    if (image) {
      const blob = await image.blob();
      await cache.delete('/__shared__');
      files.push(new File([blob], `shared-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }));
    }
    let text = '';
    const note = await cache.match('/__shared_text__');
    if (note) {
      text = (await note.text()).trim();
      await cache.delete('/__shared_text__');
    }
    return text || files.length ? { text, files } : null;
  } catch {
    return null;
  }
}
