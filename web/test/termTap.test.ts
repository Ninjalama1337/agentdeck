import { describe, expect, it } from 'vitest';
import { isMouseButtonReport, wheelSequence } from '../src/features/code/termScroll';

describe('isMouseButtonReport', () => {
  it('matches SGR press, release and drag', () => {
    expect(isMouseButtonReport('\u001b[<0;12;5M')).toBe(true);
    expect(isMouseButtonReport('\u001b[<0;12;5m')).toBe(true);
    expect(isMouseButtonReport('\u001b[<32;3;4M')).toBe(true);
  });
  it('matches X10 reports', () => {
    expect(isMouseButtonReport(`\u001b[M${String.fromCharCode(32, 33, 33)}`)).toBe(true);
  });
  it('leaves wheel events and typing alone', () => {
    expect(isMouseButtonReport(wheelSequence(true, 4, 4))).toBe(false);
    expect(isMouseButtonReport(wheelSequence(false, 4, 4))).toBe(false);
    expect(isMouseButtonReport(`\u001b[M${String.fromCharCode(96, 33, 33)}`)).toBe(false);
    expect(isMouseButtonReport('hello')).toBe(false);
    expect(isMouseButtonReport('\u001b[A')).toBe(false);
  });
});
