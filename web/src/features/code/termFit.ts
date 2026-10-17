/**
 * Terminal height on the phone while the soft keyboard is up.
 *
 * Agent TUIs lay themselves out for the height they get: Claude Code's
 * full-screen mode needs ~17 rows and below that cuts off its prompt box and
 * status line from the bottom. Fitting the terminal to the space above the
 * keyboard (~9 rows) therefore left the phone showing the top of a screen
 * whose input line was gone. Instead the PTY keeps the rows it had without the
 * keyboard, and the host shows the slice of that screen around the cursor.
 */

/** Rows that fit `height` px of host (FitAddon's arithmetic). */
export function rowsFor(height: number, padding: number, cellHeight: number): number {
  return Math.max(1, Math.floor((height - padding) / cellHeight));
}

/**
 * How far (px) to move a screen of `rows` rows up so that `visible` px of it
 * show the cursor row: the bottom of the screen when the cursor is in it (an
 * agent's prompt box, the status line below it), else the cursor as the last
 * line — the output above it is what the typing refers to.
 */
export function sliceOffset(rows: number, cellHeight: number, visible: number, cursorRow: number): number {
  const total = rows * cellHeight;
  if (total <= visible) return 0;
  const bottom = total - visible;
  const cursorTop = cursorRow * cellHeight;
  if (cursorTop >= bottom) return bottom;
  return Math.max(0, cursorTop + cellHeight - visible);
}
