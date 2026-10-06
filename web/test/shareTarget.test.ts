import { describe, expect, it } from 'vitest';
import { shareFileName } from '../src/util/shareTarget';

describe('shareFileName', () => {
  it('keeps a usable name and gives a nameless or extension-less file one', () => {
    expect(shareFileName('Screenshot_2026.png', 'image/png', 0)).toBe('Screenshot_2026.png');
    expect(shareFileName('1000012345', 'image/jpeg', 0)).toBe('1000012345.jpg');
    expect(shareFileName('', 'image/webp', 2)).toBe('shared-3.webp');
    expect(shareFileName('notes', 'application/octet-stream', 0)).toBe('notes');
    expect(shareFileName('a/b:c?.pdf', 'application/pdf', 0)).toBe('a_b_c_.pdf');
    expect(shareFileName('drawing', 'image/svg+xml', 0)).toBe('drawing.svg');
  });
});
