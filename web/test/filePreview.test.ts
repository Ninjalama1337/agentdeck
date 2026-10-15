import { describe, expect, it } from 'vitest';
import { isBinaryPreview, parseDelimited, previewKind } from '../src/features/files/previewKind';

describe('previewKind', () => {
  it('maps extensions, case-insensitive', () => {
    expect(previewKind('docs/README.md')).toBe('markdown');
    expect(previewKind('a/logo.SVG')).toBe('image');
    expect(previewKind('report.pdf')).toBe('pdf');
    expect(previewKind('data.tsv')).toBe('table');
    expect(previewKind('index.html')).toBe('html');
    expect(previewKind('Makefile')).toBeNull();
    expect(previewKind('main.ts')).toBeNull();
    expect(isBinaryPreview('image')).toBe(true);
    expect(isBinaryPreview('markdown')).toBe(false);
  });
});

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, embedded delimiters and CRLF', () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n', ',')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
  it('splits TSV and caps rows', () => {
    expect(parseDelimited('a\tb\nc\td', '\t')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseDelimited('1\n2\n3\n4\n', ',', 2)).toHaveLength(2);
  });
});
