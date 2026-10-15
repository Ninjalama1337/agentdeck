import { beforeEach, describe, expect, it } from 'vitest';
import { isSessionUnread, useUnread } from '../src/store/unread';

const data = (extra: Partial<{ since: number; viewed: Record<string, number>; marked: string[] }> = {}) => ({
  since: 1000,
  viewed: {},
  marked: [],
  ...extra,
});

describe('isSessionUnread', () => {
  it('flags a chat that changed after it was seen and is done', () => {
    expect(isSessionUnread({ id: 's', status: 'idle', updatedAt: 2000 }, data({ viewed: { s: 1500 } }))).toBe(true);
    expect(isSessionUnread({ id: 's', status: 'idle', updatedAt: 1400 }, data({ viewed: { s: 1500 } }))).toBe(false);
  });
  it('ignores what happened before the feature started and chats still working', () => {
    expect(isSessionUnread({ id: 's', status: 'idle', updatedAt: 900 }, data())).toBe(false);
    expect(isSessionUnread({ id: 's', status: 'running', updatedAt: 5000 }, data())).toBe(false);
  });
  it('honours a hand mark', () => {
    expect(isSessionUnread({ id: 's', status: 'running', updatedAt: 0 }, data({ marked: ['session:s'] }))).toBe(true);
  });
});

describe('useUnread', () => {
  beforeEach(() => useUnread.setState({ since: 0, viewed: {}, marked: [] }));
  it('marks and clears by viewing', () => {
    useUnread.getState().mark('terminal:t1');
    useUnread.getState().mark('terminal:t1');
    expect(useUnread.getState().marked).toEqual(['terminal:t1']);
    useUnread.getState().view('terminal:t1');
    expect(useUnread.getState().marked).toEqual([]);
  });
  it('remembers when a chat was viewed', () => {
    useUnread.getState().view('session:s1', 4242);
    expect(useUnread.getState().viewed).toEqual({ s1: 4242 });
  });
});
