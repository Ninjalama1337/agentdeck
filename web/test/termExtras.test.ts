import { describe, expect, it } from 'vitest';
import { osc52Text } from '../src/features/code/termExtras';

describe('osc52Text', () => {
  it('decodes the copied text, UTF-8 included', () => {
    const b64 = Buffer.from('grüße 🤖\nzeile 2').toString('base64');
    expect(osc52Text(`c;${b64}`)).toBe('grüße 🤖\nzeile 2');
    expect(osc52Text(`;${b64}`)).toBe('grüße 🤖\nzeile 2');
  });
  it('ignores queries and junk', () => {
    expect(osc52Text('c;?')).toBeNull();
    expect(osc52Text('c;')).toBeNull();
    expect(osc52Text('nosemicolon')).toBeNull();
    expect(osc52Text('c;***')).toBeNull();
  });
});
