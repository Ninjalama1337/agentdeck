import { describe, expect, it } from 'vitest';
import { selectionRange } from '../src/features/code/termSelect';

describe('selectionRange (touch select)', () => {
  it('covers one character when finger goes down and up on the same cell', () => {
    expect(selectionRange({ col: 4, row: 10 }, { col: 4, row: 10 }, 80)).toEqual({ column: 4, row: 10, length: 1 });
  });

  it('runs to the end cell inclusive within a line', () => {
    expect(selectionRange({ col: 2, row: 0 }, { col: 7, row: 0 }, 80)).toEqual({ column: 2, row: 0, length: 6 });
  });

  it('spans several lines', () => {
    // From col 70 on line 3 to col 5 on line 5: 10 + 80 + 6 cells.
    expect(selectionRange({ col: 70, row: 3 }, { col: 5, row: 5 }, 80)).toEqual({ column: 70, row: 3, length: 96 });
  });

  it('is the same when dragged backwards', () => {
    expect(selectionRange({ col: 5, row: 5 }, { col: 70, row: 3 }, 80)).toEqual(selectionRange({ col: 70, row: 3 }, { col: 5, row: 5 }, 80));
    expect(selectionRange({ col: 9, row: 1 }, { col: 3, row: 1 }, 80)).toEqual({ column: 3, row: 1, length: 7 });
  });
});
