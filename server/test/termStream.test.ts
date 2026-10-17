import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COALESCE_MAX_CHARS, COALESCE_MS, createTerminalStream } from '../src/ws/termStream.js';

type Sent = [string, string, unknown];

describe('terminal stream coalescing', () => {
  let sent: Sent[];
  const stream = () => createTerminalStream((id, event, payload) => sent.push([id, event, payload]));

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('joins chunks of one burst into a single frame per terminal', () => {
    const s = stream();
    s.data('a', 'he');
    s.data('b', 'x');
    s.data('a', 'llo');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(sent).toEqual([
      ['a', 'terminal:data', { id: 'a', data: 'hello' }],
      ['b', 'terminal:data', { id: 'b', data: 'x' }],
    ]);
  });

  it('flushes bulk output without waiting', () => {
    const s = stream();
    s.data('a', 'x'.repeat(COALESCE_MAX_CHARS - 1));
    expect(sent).toHaveLength(0);
    s.data('a', 'yy');
    expect(sent).toHaveLength(1);
    expect((sent[0]![2] as { data: string }).data).toHaveLength(COALESCE_MAX_CHARS + 1);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(sent).toHaveLength(1);
  });

  it('sends pending output before the exit', () => {
    const s = stream();
    s.data('a', 'bye');
    s.exit('a', 0);
    expect(sent).toEqual([
      ['a', 'terminal:data', { id: 'a', data: 'bye' }],
      ['a', 'terminal:exit', { id: 'a', code: 0 }],
    ]);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(sent).toHaveLength(2);
  });
});
