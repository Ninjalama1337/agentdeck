import { describe, expect, it } from 'vitest';
import { ThinkTagSplitter, splitThinkTags } from '@agentdeck/shared';

describe('think tag splitter', () => {
  it('splits inline reasoning from the answer', () => {
    expect(splitThinkTags('<think>hmm\nwell</think>\nAnswer')).toEqual({ text: 'Answer', thinking: 'hmm\nwell' });
  });
  it('handles tags split across chunks', () => {
    const s = new ThinkTagSplitter();
    const parts = ['Hi <th', 'ink>a', 'b</thi', 'nk>Done'].flatMap((c) => s.push(c)).concat(s.end());
    expect(parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')).toBe('Hi Done');
    expect(parts.filter((p) => p.kind === 'thinking').map((p) => p.text).join('')).toBe('ab');
  });
  it('keeps a lone "<" that is not a tag', () => {
    expect(splitThinkTags('a < b and <div>')).toEqual({ text: 'a < b and <div>', thinking: '' });
  });
  it('treats an unclosed tag as thinking', () => {
    expect(splitThinkTags('<thinking>still going').thinking).toBe('still going');
  });
});
