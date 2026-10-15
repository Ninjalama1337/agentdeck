import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankItems } from '../src/util/quickOpen';
import { matchShortcut } from '../src/util/shortcuts';

describe('fuzzyScore', () => {
  it('matches letters in order and rejects the rest', () => {
    expect(fuzzyScore('tv', 'src/TerminalView.tsx')).not.toBeNull();
    expect(fuzzyScore('vt', 'ab')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers the file name over folders and runs over scattered letters', () => {
    const name = fuzzyScore('panes', 'web/src/features/code/CodePanes.tsx')!;
    const folder = fuzzyScore('panes', 'web/src/panes/index.ts')!;
    expect(name).toBeGreaterThan(folder);
    expect(fuzzyScore('diff', 'git/DiffView.tsx')!).toBeGreaterThan(fuzzyScore('diff', 'd/i/f/f.ts')!);
  });
});

describe('rankItems', () => {
  const items = [
    { text: 'src/util/format.ts' },
    { text: 'Settings' },
    { text: 'server/src/term/manager.ts' },
  ];
  it('keeps the order without a query', () => {
    expect(rankItems(items, '  ').map((i) => i.text)).toEqual(items.map((i) => i.text));
  });
  it('drops non-matches and sorts the best first', () => {
    expect(rankItems(items, 'manager').map((i) => i.text)).toEqual(['server/src/term/manager.ts']);
    expect(rankItems(items, 'set')[0]!.text).toBe('Settings');
  });
  it('lets a boost lift a group', () => {
    const boosted = rankItems([{ text: 'shell b' }, { text: 'shell a', boost: 5 }], 'shell');
    expect(boosted[0]!.text).toBe('shell a');
  });
});

describe('quick open shortcut', () => {
  const key = (k: string, extra: Partial<{ shiftKey: boolean; metaKey: boolean }> = {}) => ({
    key: k,
    ctrlKey: !extra.metaKey,
    metaKey: !!extra.metaKey,
    altKey: false,
    shiftKey: !!extra.shiftKey,
  });
  it('is Ctrl+P outside a terminal and Ctrl+Shift+P anywhere', () => {
    expect(matchShortcut(key('p'))).toEqual({ type: 'quick-open' });
    expect(matchShortcut(key('p'), { inTerminal: true })).toBeNull();
    expect(matchShortcut(key('P', { shiftKey: true }), { inTerminal: true })).toEqual({ type: 'quick-open' });
    expect(matchShortcut(key('1', { shiftKey: true }))).toBeNull();
  });
});
