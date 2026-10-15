/**
 * Touch text selection for the phone terminal.
 *
 * xterm.js selects with a mouse only, and on tmux/TUI screens mouse input
 * belongs to the application anyway. So a long press opens a small menu;
 * "Select text" switches the terminal into a select mode in which the finger
 * goes down on the first character, drags to the last, and lifting it copies
 * the range to the clipboard. Works across lines on what is on screen.
 */
import type { Terminal } from '@xterm/xterm';

/** 0-based cell in the buffer (row = absolute buffer line). */
export interface Cell {
  col: number;
  row: number;
}

/** Arguments for `term.select()` covering a..b inclusive, in either order. */
export function selectionRange(a: Cell, b: Cell, cols: number): { column: number; row: number; length: number } {
  const [start, end] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  return { column: start.col, row: start.row, length: (end.row - start.row) * cols + end.col - start.col + 1 };
}

/** Buffer cell under a viewport position, clamped to the visible screen. */
export function cellUnder(term: Terminal, screen: HTMLElement, clientX: number, clientY: number): Cell {
  const rect = screen.getBoundingClientRect();
  const cols = Math.max(1, term.cols);
  const rows = Math.max(1, term.rows);
  const col = Math.min(cols - 1, Math.max(0, Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * cols)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * rows)));
  return { col, row: term.buffer.active.viewportY + row };
}

/** Clipboard write that also works where the async API is missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

/**
 * Single-finger long press on `host` → `onLongPress`. Moving, a second finger
 * or lifting early cancels. The press that fired does not also tap the
 * terminal (no keyboard, no click sent to the app), and the browser's own
 * long-press menu stays away.
 */
export function installLongPress(host: HTMLElement, onLongPress: (x: number, y: number) => void): () => void {
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  let touchedAt = 0;
  /** Until then, mouse events are the browser's emulation of the long press — not a tap. */
  let swallowUntil = 0;
  const cancel = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const onStart = (e: TouchEvent): void => {
    cancel();
    fired = false;
    touchedAt = Date.now();
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = window.setTimeout(() => {
      timer = null;
      fired = true;
      onLongPress(startX, startY);
    }, LONG_PRESS_MS);
  };
  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || !t || Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_TOLERANCE) cancel();
  };
  const onEnd = (e: TouchEvent): void => {
    cancel();
    if (fired) {
      if (e.cancelable) e.preventDefault();
      swallowUntil = Date.now() + 800;
    }
    fired = false;
  };
  // xterm focuses its input on mousedown — that would flash the soft keyboard.
  const onMouse = (e: Event): void => {
    if (!fired && Date.now() > swallowUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const mouseEvents = ['mousedown', 'mouseup', 'click'] as const;
  // Only the touch-triggered menu — a mouse right-click keeps the browser's.
  const onContextMenu = (e: Event): void => {
    if (Date.now() - touchedAt < 2000) e.preventDefault();
  };
  host.addEventListener('touchstart', onStart, { passive: true });
  host.addEventListener('touchmove', onMove, { passive: true });
  host.addEventListener('touchend', onEnd, { passive: false });
  host.addEventListener('touchcancel', cancel, { passive: true });
  host.addEventListener('contextmenu', onContextMenu);
  for (const type of mouseEvents) host.addEventListener(type, onMouse, true);
  return () => {
    for (const type of mouseEvents) host.removeEventListener(type, onMouse, true);
    cancel();
    host.removeEventListener('touchstart', onStart);
    host.removeEventListener('touchmove', onMove);
    host.removeEventListener('touchend', onEnd);
    host.removeEventListener('touchcancel', cancel);
    host.removeEventListener('contextmenu', onContextMenu);
  };
}

/**
 * Select mode: finger down = first character, drag = extend, lift = `onDone`
 * with the selected text. Listens in the capture phase and swallows the
 * touches, so neither xterm, the wheel translation nor native panning see them.
 */
export function installTouchSelect(
  term: Terminal,
  host: HTMLElement,
  onChange: (text: string) => void,
  onDone: (text: string) => void,
): () => void {
  const screen = host.querySelector<HTMLElement>('.xterm-screen') ?? host;
  let anchor: Cell | null = null;
  const extend = (t: Touch): void => {
    if (!anchor) return;
    const r = selectionRange(anchor, cellUnder(term, screen, t.clientX, t.clientY), term.cols);
    term.select(r.column, r.row, r.length);
    onChange(term.getSelection());
  };
  const swallow = (e: TouchEvent): void => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  const onStart = (e: TouchEvent): void => {
    swallow(e);
    const t = e.touches[0];
    if (e.touches.length !== 1 || !t) return;
    anchor = cellUnder(term, screen, t.clientX, t.clientY);
    extend(t);
  };
  const onMove = (e: TouchEvent): void => {
    swallow(e);
    const t = e.touches[0];
    if (t) extend(t);
  };
  const onEnd = (e: TouchEvent): void => {
    swallow(e);
    if (!anchor) return;
    anchor = null;
    onDone(term.getSelection());
  };
  const onCancel = (e: TouchEvent): void => {
    swallow(e);
    anchor = null;
  };
  const opts = { capture: true, passive: false } as const;
  host.addEventListener('touchstart', onStart, opts);
  host.addEventListener('touchmove', onMove, opts);
  host.addEventListener('touchend', onEnd, opts);
  host.addEventListener('touchcancel', onCancel, opts);
  const prevTouchAction = host.style.touchAction;
  host.style.touchAction = 'none';
  return () => {
    host.style.touchAction = prevTouchAction;
    host.removeEventListener('touchstart', onStart, opts);
    host.removeEventListener('touchmove', onMove, opts);
    host.removeEventListener('touchend', onEnd, opts);
    host.removeEventListener('touchcancel', onCancel, opts);
  };
}
