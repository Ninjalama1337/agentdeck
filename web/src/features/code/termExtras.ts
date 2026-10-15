/**
 * Terminal upgrades (after Orca's terminal): Unicode 11 widths for emoji and
 * symbols, the WebGL renderer on the desktop, and OSC 52 — what tmux or a TUI
 * copies lands on the device clipboard.
 */
import type { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';

export function applyUnicode11(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
}

/**
 * GPU rendering; falls back to the DOM renderer when WebGL is missing or the
 * context is lost (too many contexts, GPU reset). Returns a disposer.
 */
export function tryWebgl(term: Terminal): () => void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
    return () => webgl.dispose();
  } catch {
    return () => undefined;
  }
}

/** Text of an OSC 52 payload ("c;BASE64"), or null for queries and junk. */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const b64 = data.slice(sep + 1);
  if (!b64 || b64 === '?') return null;
  try {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Hands OSC 52 copies to `onCopy`. */
export function handleOsc52(term: Terminal, onCopy: (text: string) => void): { dispose(): void } {
  return term.parser.registerOscHandler(52, (data) => {
    const text = osc52Text(data);
    if (text) onCopy(text);
    return true;
  });
}
