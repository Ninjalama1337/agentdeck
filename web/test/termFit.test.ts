import { describe, expect, it } from 'vitest';
import { rowsFor, sliceOffset } from '../src/features/code/termFit';

describe('terminal slice while the keyboard is up', () => {
  it('counts rows like FitAddon', () => {
    expect(rowsFor(400, 4, 15)).toBe(26);
    expect(rowsFor(3, 4, 15)).toBe(1);
  });

  it('shows the bottom when the cursor is in it — prompt box and status line', () => {
    // 26 rows of 15 px in 135 px: Claude Code's prompt on row 22, status on 25.
    expect(sliceOffset(26, 15, 135, 22)).toBe(26 * 15 - 135);
  });

  it('keeps a cursor higher up on screen as the last line', () => {
    expect(sliceOffset(26, 15, 135, 10)).toBe(11 * 15 - 135);
    // A cursor near the top needs no shift.
    expect(sliceOffset(26, 15, 135, 2)).toBe(0);
  });

  it('does nothing when everything fits', () => {
    expect(sliceOffset(9, 15, 135, 8)).toBe(0);
  });
});
