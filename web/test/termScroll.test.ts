import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { appOwnsScreen, type MouseMode } from '../src/features/code/termScroll';

/** Only the two things appOwnsScreen looks at. */
const term = (type: 'normal' | 'alternate') => ({ buffer: { active: { type } } }) as unknown as Terminal;
const mouse = (sgr: boolean): MouseMode => ({ sgrActive: () => sgr, dispose: () => undefined });

describe('which screen a swipe scrolls', () => {
  it('wheels the application on the alternate screen', () => {
    expect(appOwnsScreen(term('alternate'), mouse(false))).toBe(true);
    expect(appOwnsScreen(term('alternate'), mouse(true))).toBe(true);
  });

  it('wheels the application when it reports the mouse', () => {
    // Replayed snapshots restore mouse modes; the alternate screen came with
    // them once the server started putting it in front of the cells.
    expect(appOwnsScreen(term('normal'), mouse(true))).toBe(true);
  });

  it('keeps native panning for a plain shell', () => {
    expect(appOwnsScreen(term('normal'), mouse(false))).toBe(false);
    expect(appOwnsScreen(term('normal'), null)).toBe(false);
  });
});
