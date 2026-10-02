import { describe, expect, it } from 'vitest';
import { imeDiff } from '../src/features/code/termIme';

const DEL = '\u007f';

describe('imeDiff', () => {
  it('sends only what was appended', () => {
    expect(imeDiff('', 'h')).toBe('h');
    expect(imeDiff('hel', 'hello ')).toBe('lo ');
    expect(imeDiff('git ', 'git commit ')).toBe('commit ');
    expect(imeDiff('same', 'same')).toBe('');
  });

  it('takes back what the IME deleted', () => {
    expect(imeDiff('hello', 'hell')).toBe(DEL);
    expect(imeDiff('hello', '')).toBe(DEL.repeat(5));
  });

  it('replaces a corrected word instead of repeating it', () => {
    // autocorrect of the same length — xterm resends the whole value here
    expect(imeDiff('teh ', 'the ')).toBe(`${DEL.repeat(3)}he `);
    // suggestion tapped for a word typed earlier on the line
    expect(imeDiff('git commti ', 'git commit ')).toBe(`${DEL.repeat(3)}it `);
    expect(imeDiff('helo ', 'hello ')).toBe(`${DEL.repeat(2)}lo `);
  });

  it('counts deletions in characters, not UTF-16 units', () => {
    expect(imeDiff('ok 👍', 'ok ')).toBe(DEL);
    // same high surrogate, different emoji: the pair is replaced as a whole
    expect(imeDiff('😀', '😁')).toBe(`${DEL}😁`);
  });

  it('turns a line break into Enter', () => {
    expect(imeDiff('ls', 'ls\n')).toBe('\r');
  });
});
