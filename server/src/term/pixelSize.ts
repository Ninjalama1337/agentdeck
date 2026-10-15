/**
 * Pixel-size replies for images in the terminal. tmux places Sixel images by
 * the client's cell size in pixels; the PTY reports 0 there (node-pty cannot
 * set it), so tmux asks with CSI 14 t / CSI 16 t — and the server's emulator,
 * which answers terminal queries, replies with the cell size the app measured
 * (or a typical one until it reports). Without this tmux shows a placeholder.
 */
import type xtermHeadless from '@xterm/headless';

export interface CellSize {
  width: number;
  height: number;
}

/** A typical monospace cell at the app's default 12 px font. */
export const DEFAULT_CELL: CellSize = { width: 7, height: 16 };

export function pixelReply(param: number, cols: number, rows: number, cell: CellSize): string | null {
  // CSI 14 t → text area in pixels: CSI 4 ; height ; width t
  if (param === 14) return `\u001b[4;${rows * cell.height};${cols * cell.width}t`;
  // CSI 16 t → one cell in pixels: CSI 6 ; height ; width t
  if (param === 16) return `\u001b[6;${cell.height};${cell.width}t`;
  return null;
}

/**
 * xterm only calls CSI t handlers for window ops that are switched on; these
 * two are queries (no window is moved or resized), answered by the handler below.
 */
export const PIXEL_QUERIES = { getWinSizePixels: true, getCellSizePixels: true } as const;

export function answerPixelQueries(
  screen: InstanceType<typeof xtermHeadless.Terminal>,
  reply: (data: string) => void,
  cell: () => CellSize,
): { dispose(): void } {
  return screen.parser.registerCsiHandler({ final: 't' }, (params) => {
    const p = typeof params[0] === 'number' ? params[0] : -1;
    const out = pixelReply(p, screen.cols, screen.rows, cell());
    if (!out) return false;
    reply(out);
    return true;
  });
}
