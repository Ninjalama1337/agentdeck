/**
 * Images and files that reach an input without the attach button: pasted
 * (Ctrl+V, the keyboard's clipboard), dropped onto it, or inserted by the
 * phone keyboard itself — a screenshot or picture from Gboard's clipboard row
 * (APK: mobile/native/AgentDeckWebView.java and MediaInputPlugin.java).
 *
 * Whatever the way in, the input that has the focus gets them:
 * useIncomingFiles() is what an input takes them with.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { isNativePlatform } from './platform';
import { shareFileName } from './shareTarget';

/** DOM event carrying files the keyboard inserted into the focused field. */
const FILES_EVENT = 'agentdeck:files';

interface NativeMediaFile {
  id: number;
  name: string;
  mime: string;
  size: number;
}

function plugin() {
  return window.Capacitor?.Plugins?.MediaInput as unknown as
    | {
        addListener?: (ev: string, cb: (e: { files?: NativeMediaFile[] }) => void) => unknown;
        read?: (o: { id: number }) => Promise<{ data: string }>;
        clipboard?: () => Promise<{ text?: string; files?: NativeMediaFile[] }>;
      }
    | undefined;
}

/** Clipboards and keyboards name every image alike ("image.png") or not at all. */
function named(file: File, index: number): File {
  const generic = !file.name || /^(image|blob|unnamed|clipboard)(\.[a-z0-9]+)?$/i.test(file.name);
  if (!generic) return file;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const kind = file.type.startsWith('image/') ? 'screenshot' : 'pasted';
  const name = shareFileName(`${kind}-${stamp}${index ? `-${index + 1}` : ''}`, file.type, index);
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/**
 * The files of a paste or drop. None when it also carries plain text: copying
 * cells or styled text puts a picture of them next to the text, and the text
 * is what was meant.
 */
export function filesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data || data.files.length === 0) return [];
  if (Array.from(data.types).includes('text/plain')) return [];
  return Array.from(data.files).map(named);
}

async function nativeFiles(metas: NativeMediaFile[]): Promise<File[]> {
  const files: File[] = [];
  for (const [index, meta] of metas.entries()) {
    const res = await plugin()?.read?.({ id: meta.id });
    if (!res?.data) continue;
    const raw = atob(res.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const file = new File([bytes], shareFileName(meta.name, meta.mime, index), { type: meta.mime });
    files.push(named(file, index));
  }
  return files;
}

/**
 * APK: hands what the keyboard inserts to the focused input. `unclaimed` gets
 * the files when no input took them, `onProblem` a readable line when one
 * could not be read.
 */
export function listenForKeyboardMedia(unclaimed: (files: File[]) => void, onProblem: (message: string) => void): void {
  if (!isNativePlatform()) return;
  plugin()?.addListener?.('media', (event) => {
    void nativeFiles(event.files ?? []).then(
      (files) => {
        if (!files.length) return;
        const target = document.activeElement ?? document.body;
        const taken = !target.dispatchEvent(new CustomEvent(FILES_EVENT, { detail: files, bubbles: true, cancelable: true }));
        if (!taken) unclaimed(files);
      },
      (err) => onProblem(err instanceof Error ? err.message : 'The image could not be read'),
    );
  });
}

/**
 * What the clipboard holds right now — for a "paste" button. Throws when the
 * clipboard cannot be read (no permission, or a browser without the API).
 */
export async function readClipboard(): Promise<{ text: string; files: File[] }> {
  if (isNativePlatform() && plugin()?.clipboard) {
    const clip = await plugin()!.clipboard!();
    return { text: clip.text ?? '', files: await nativeFiles(clip.files ?? []) };
  }
  if (typeof navigator.clipboard?.read === 'function') {
    try {
      const files: File[] = [];
      let text = '';
      for (const item of await navigator.clipboard.read()) {
        const image = item.types.find((t) => t.startsWith('image/'));
        if (item.types.includes('text/plain')) text ||= await (await item.getType('text/plain')).text();
        else if (image) files.push(named(new File([await item.getType(image)], '', { type: image }), files.length));
      }
      if (text || files.length) return { text, files };
    } catch {
      // No access to rich content: the text alone may still be readable.
    }
  }
  return { text: await navigator.clipboard.readText(), files: [] };
}

/**
 * Makes the element behind `ref` take pasted, dropped and keyboard-inserted
 * files: `onFiles` gets them instead of whatever lies below. Listens in the
 * capture phase, so it comes before a terminal's own paste handling.
 */
export function useIncomingFiles(ref: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void, enabled = true): void {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const take = (e: Event, files: File[]) => {
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current(files);
    };
    const onPaste = (e: ClipboardEvent) => take(e, filesFromTransfer(e.clipboardData));
    const onDrop = (e: DragEvent) => take(e, filesFromTransfer(e.dataTransfer));
    const onDragOver = (e: DragEvent) => {
      // Without this the browser refuses the drop (and opens the file instead).
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    const onInserted = (e: Event) => take(e, (e as CustomEvent<File[]>).detail ?? []);
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('drop', onDrop, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener(FILES_EVENT, onInserted);
    return () => {
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('drop', onDrop, true);
      el.removeEventListener('dragover', onDragOver, true);
      el.removeEventListener(FILES_EVENT, onInserted);
    };
  }, [ref, enabled]);
}
