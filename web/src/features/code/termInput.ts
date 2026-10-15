/**
 * Terminal input helpers shared by the compose bar, key bar and snippets.
 */
import { useAppStore } from '../../store/appStore';

export const KEYS = {
  enter: '\r',
  esc: '\u001b',
  tab: '\t',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  home: '\u001b[H',
  end: '\u001b[F',
  pgUp: '\u001b[5~',
  pgDn: '\u001b[6~',
  del: '\u001b[3~',
} as const;

/** Ctrl+<letter> → control character (a → \x01 …). */
export function ctrlChar(ch: string): string | undefined {
  const c = ch.toLowerCase();
  if (c.length !== 1) return undefined;
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  if (c === '[') return '\u001b';
  if (c === '\\') return '\u001c';
  if (c === ']') return '\u001d';
  if (c === ' ') return '\u0000';
  return undefined;
}

export function sendRaw(id: string, data: string): void {
  // Server caps a single WS input frame at 4 KiB — split long pastes.
  for (let i = 0; i < data.length; i += 4000) {
    useAppStore.getState().sendTerminalInput(id, data.slice(i, i + 4000));
  }
}

/**
 * Types `text` into the terminal. Multi-line text goes in as a bracketed
 * paste so TUIs (Claude Code, Codex, OpenCode) treat it as one message
 * instead of submitting at the first newline; `submit` then presses Enter.
 */
export function sendText(id: string, text: string, submit = true): void {
  if (text.includes('\n')) {
    sendRaw(id, `\u001b[200~${text.replace(/\r?\n/g, '\r')}\u001b[201~`);
    if (submit) window.setTimeout(() => sendRaw(id, KEYS.enter), 60);
    return;
  }
  if (!submit) {
    sendRaw(id, text);
    return;
  }
  // TUIs debounce paste detection — a tiny gap before Enter keeps the text
  // and the submit key from being merged into one "paste".
  sendRaw(id, text);
  window.setTimeout(() => sendRaw(id, KEYS.enter), text.length > 0 ? 40 : 0);
}

/** Terminal query replies xterm.js generates — the server emulator answers these. */
// eslint-disable-next-line no-control-regex
const REPLY_RE = /^(\u001b\[[46];\d+;\d+t|\u001b\[\??\d+(;\d+)*R|\u001b\[[?>][\d;]*c|\u001b\]1[0-2];rgb:[^\u0007\u001b]*(\u0007|\u001b\\)|\u001b\[\?\d+;\d+\$y)+$/;

export function isTerminalReply(data: string): boolean {
  return REPLY_RE.test(data);
}

/** Rough cols/rows for a terminal of the current viewport before xterm measures. */
export function estimateSize(fontSize: number): { cols: number; rows: number } {
  const w = Math.min(window.innerWidth, 640) - 20;
  const h = window.innerHeight - 290;
  return {
    cols: Math.max(30, Math.floor(w / (fontSize * 0.6))),
    rows: Math.max(10, Math.floor(h / (fontSize * 1.2))),
  };
}
