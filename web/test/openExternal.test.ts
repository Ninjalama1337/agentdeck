import { describe, expect, it } from 'vitest';
import { isWebUrl } from '../src/util/openExternal';

describe('isWebUrl', () => {
  it('accepts http(s) links only', () => {
    expect(isWebUrl('https://example.com/a')).toBe(true);
    expect(isWebUrl('http://192.168.1.2:8787')).toBe(true);
    expect(isWebUrl('mailto:a@b.c')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});
