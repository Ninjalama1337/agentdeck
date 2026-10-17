/**
 * Scrolling for application-owned screens (tmux / agent TUIs).
 *
 * AgentDeck terminals run inside tmux, which keeps the attached terminal on
 * the alternate screen — the client-side xterm never builds scrollback of its
 * own, the history lives in tmux (or in the TUI's transcript). The only way to
 * reach it is wheel input: tmux (`mouse on`) scrolls copy-mode or forwards the
 * events to pane apps that use the mouse. Touch devices produce no wheel
 * events, so finger drags and the scroll buttons synthesize SGR mouse
 * sequences here. Locally scrollable screens (plain shell over a direct PTY)
 * keep native viewport panning.
 */
import type { Terminal } from '@xterm/xterm';

/** DECSET modes in which the program consumes mouse events. */
const MOUSE_REPORTING = new Set([9, 1000, 1002, 1003]);

export interface MouseMode {
  /** Mouse reporting is on AND SGR (1006) encoded — wheel input is safe to send. */
  sgrActive: () => boolean;
  dispose: () => void;
}

/**
 * Tracks mouse-reporting DECSET/DECRST in the output stream via xterm's
 * parser API — chunk boundaries can split escape sequences, the parser cannot.
 */
export function trackMouseMode(term: Terminal): MouseMode {
  let reporting = false;
  let sgr = false;
  const apply = (params: (number | number[])[], set: boolean): void => {
    for (const p of params) {
      if (typeof p !== 'number') continue;
      if (p === 1006) sgr = set;
      if (MOUSE_REPORTING.has(p)) reporting = set;
    }
  };
  const setHandler = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    apply(params, true);
    return false; // xterm keeps its default DECSET handling
  });
  const resetHandler = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    apply(params, false);
    return false;
  });
  return {
    sgrActive: () => reporting && sgr,
    dispose: () => {
      setHandler.dispose();
      resetHandler.dispose();
    },
  };
}

/** One SGR mouse-wheel event: button 64 = up, 65 = down. */
export function wheelSequence(down: boolean, col: number, row: number): string {
  return `\u001b[<${down ? 65 : 64};${col};${row}M`;
}

/**
 * The rows themselves — taller than the host and shifted while the phone
 * keyboard is up (termFit.ts), so cells are measured on it, not on the host.
 */
function screenRect(term: Terminal, host: HTMLElement): DOMRect {
  return (term.element?.querySelector<HTMLElement>('.xterm-screen') ?? host).getBoundingClientRect();
}

/** 1-based cell under a viewport position, clamped to the screen. */
export function cellAt(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { col: number; row: number } {
  const rect = screenRect(term, host);
  const col = Math.min(term.cols, Math.max(1, Math.ceil((clientX - rect.left) / (rect.width / Math.max(1, term.cols)))));
  const row = Math.min(term.rows, Math.max(1, Math.ceil((clientY - rect.top) / (rect.height / Math.max(1, term.rows)))));
  return { col, row };
}

/** Sends a burst of wheel events at the centre of the screen (scroll buttons). */
export function sendWheelBurst(term: Terminal, down: boolean, ticks: number, send: (data: string) => void): void {
  const seq = wheelSequence(down, Math.max(1, Math.ceil(term.cols / 2)), Math.max(1, Math.ceil(term.rows / 2)));
  for (let i = 0; i < ticks; i++) send(seq);
}

/**
 * Translates single-finger vertical drags into wheel events while the
 * application owns the screen; scrollable local buffers keep native panning.
 * Two-finger gestures are left to the pinch-zoom handler in TerminalView.
 */
export function installTouchWheelScroll(
  term: Terminal,
  host: HTMLElement,
  wheelable: () => boolean,
  send: (data: string) => void,
): () => void {
  let touchId: number | null = null;
  let lastY = 0;
  let accum = 0;

  /** Drag distance per wheel event — ~1.2 terminal rows, never below 14 px. */
  const step = (): number => {
    const rect = screenRect(term, host);
    return Math.max(14, (rect.height / Math.max(1, term.rows)) * 1.2);
  };
  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1 || !wheelable()) {
      touchId = null;
      return;
    }
    touchId = e.touches[0].identifier;
    lastY = e.touches[0].clientY;
    accum = 0;
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (touchId === null || e.touches.length !== 1 || e.touches[0].identifier !== touchId) return;
    const t = e.touches[0];
    accum += t.clientY - lastY;
    lastY = t.clientY;
    const s = step();
    if (Math.abs(accum) < s) return;
    const ticks = Math.trunc(accum / s);
    accum -= ticks * s;
    const { col, row } = cellAt(term, host, t.clientX, t.clientY);
    const seq = wheelSequence(ticks < 0, col, row); // finger down ⇒ scroll up
    for (let i = 0; i < Math.abs(ticks); i++) send(seq);
    e.preventDefault();
  };
  const onTouchEnd = (): void => {
    touchId = null;
  };

  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove', onTouchMove, { passive: false });
  host.addEventListener('touchend', onTouchEnd, { passive: true });
  host.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return () => {
    host.removeEventListener('touchstart', onTouchStart);
    host.removeEventListener('touchmove', onTouchMove);
    host.removeEventListener('touchend', onTouchEnd);
    host.removeEventListener('touchcancel', onTouchEnd);
  };
}

/**
 * A mouse button report (press, release, drag) in SGR or X10 encoding — wheel
 * reports (button bit 64) are not.
 */
export function isMouseButtonReport(data: string): boolean {
  const sgr = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (sgr) return (Number(sgr[1]) & 64) === 0;
  return data.length === 6 && data.startsWith('\u001b[M') && ((data.charCodeAt(3) - 32) & 64) === 0;
}

/** Window after a touch in which mouse events count as the browser's tap emulation. */
const TAP_EMULATION_MS = 1000;

/**
 * Remembers the last touch on `host`. A tap reaches xterm as an emulated
 * click, which it reports to a TUI with mouse tracking — Claude Code then
 * moves its prompt cursor to the tapped cell, and whatever is typed next lands
 * mid-text. The caller drops button reports while `touched()` holds.
 */
export function trackTouches(host: HTMLElement): { touched: () => boolean; dispose: () => void } {
  let last = -Infinity;
  const mark = (): void => {
    last = performance.now();
  };
  const opts = { capture: true, passive: true };
  host.addEventListener('touchstart', mark, opts);
  host.addEventListener('touchend', mark, opts);
  return {
    touched: () => performance.now() - last < TAP_EMULATION_MS,
    dispose: () => {
      host.removeEventListener('touchstart', mark, opts);
      host.removeEventListener('touchend', mark, opts);
    },
  };
}
