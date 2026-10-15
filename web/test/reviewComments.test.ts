import { describe, expect, it } from 'vitest';
import { commentLocation, diffLineRefs, lineKey, reviewPrompt } from '../src/features/git/reviewComments';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function x() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+--- not a header',
  ' return a;',
  'diff --git a/new.md b/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
];

describe('diffLineRefs', () => {
  const refs = diffLineRefs(DIFF);
  it('numbers new, removed and context lines per file', () => {
    expect(refs[5]).toEqual({ kind: 'context', file: 'src/a.ts', oldLine: 10, newLine: 10 });
    expect(refs[6]).toEqual({ kind: 'del', file: 'src/a.ts', oldLine: 11 });
    expect(refs[7]).toEqual({ kind: 'add', file: 'src/a.ts', newLine: 11 });
    expect(refs[8]).toEqual({ kind: 'add', file: 'src/a.ts', newLine: 12 });
    expect(refs[9]).toEqual({ kind: 'context', file: 'src/a.ts', oldLine: 12, newLine: 13 });
  });
  it('treats headers as meta and follows the next file', () => {
    expect(refs.slice(0, 4).map((r) => r.kind)).toEqual(['meta', 'meta', 'meta', 'meta']);
    expect(refs[15]).toEqual({ kind: 'add', file: 'new.md', newLine: 1 });
  });
  it('keys commentable lines', () => {
    expect(lineKey(refs[6]!)).toBe('old 11');
    expect(lineKey(refs[7]!)).toBe('11');
    expect(lineKey(refs[4]!)).toBeNull();
  });
});

describe('reviewPrompt', () => {
  it('lists comments by file and line with the code they are about', () => {
    const prompt = reviewPrompt([
      { id: '2', file: 'src/a.ts', line: '12', code: '+--- not a header', text: 'Remove this' },
      { id: '1', file: 'src/a.ts', line: 'old 11', code: '-const b = 2;', text: 'Why change b?' },
    ]);
    expect(prompt).toContain('Review comments on the current changes (2):');
    expect(prompt.indexOf('removed line 11')).toBeLessThan(prompt.indexOf('src/a.ts:12'));
    expect(prompt).toContain('  → Remove this');
    expect(commentLocation({ file: 'x', line: '3' })).toBe('x:3');
  });
});
