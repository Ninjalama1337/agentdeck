import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignTerminal,
  DEFAULT_PANES,
  focusedTerminal,
  focusPane,
  launchTarget,
  normalizePanes,
  paneCellClass,
  paneGridClass,
  paneOf,
  reconcilePanes,
  revealTerminal,
  setPaneCount,
  type PaneState,
} from '../src/features/code/paneLayout';

const state = (count: PaneState['count'], slots: (string | null)[], focus = 0, cleared: number[] = []): PaneState => ({
  count,
  slots,
  focus,
  cleared,
});

describe('normalizePanes (untrusted storage content)', () => {
  it('gives the default single pane for anything that is not a panes object', () => {
    for (const raw of [null, undefined, 'x', 7, [], true]) expect(normalizePanes(raw)).toEqual(DEFAULT_PANES);
  });

  it('keeps a valid state as it is', () => {
    expect(normalizePanes({ count: 3, slots: ['a', null, 'c'], focus: 2 })).toEqual(state(3, ['a', null, 'c'], 2));
  });

  it('clamps the pane count to 1–4 and pads or cuts the slots to it', () => {
    expect(normalizePanes({ count: 9, slots: ['a'] }).count).toBe(4);
    expect(normalizePanes({ count: 0, slots: [] }).count).toBe(1);
    expect(normalizePanes({ count: -3 }).count).toBe(1);
    expect(normalizePanes({ count: 2.5 }).count).toBe(1);
    expect(normalizePanes({ count: '3' }).count).toBe(1);
    expect(normalizePanes({ count: 4, slots: ['a'] }).slots).toEqual(['a', null, null, null]);
    expect(normalizePanes({ count: 2, slots: ['a', 'b', 'c', 'd'] }).slots).toEqual(['a', 'b']);
  });

  it('drops ids that are not strings, empty or shown twice', () => {
    expect(normalizePanes({ count: 4, slots: ['a', 'a', 5, ''] }).slots).toEqual(['a', null, null, null]);
    expect(normalizePanes({ count: 2, slots: 'ab' }).slots).toEqual([null, null]);
  });

  it('keeps the focus inside the panes', () => {
    expect(normalizePanes({ count: 2, slots: [], focus: 5 }).focus).toBe(0);
    expect(normalizePanes({ count: 2, slots: [], focus: -1 }).focus).toBe(0);
    expect(normalizePanes({ count: 2, slots: [], focus: 1.5 }).focus).toBe(0);
    expect(normalizePanes({ count: 2, slots: [], focus: 1 }).focus).toBe(1);
  });
});

describe('pane count', () => {
  it('growing adds empty panes, shrinking drops the last ones (the terminals keep running)', () => {
    expect(setPaneCount(state(2, ['a', 'b']), 4)).toEqual(state(4, ['a', 'b', null, null]));
    expect(setPaneCount(state(4, ['a', 'b', 'c', 'd'], 3), 2)).toEqual(state(2, ['a', 'b'], 1));
  });

  it('is a no-op for the same or an out-of-range count', () => {
    const s = state(2, ['a', 'b']);
    expect(setPaneCount(s, 2)).toBe(s);
    expect(setPaneCount(s, 99).count).toBe(4);
    expect(setPaneCount(s, 0).count).toBe(1);
  });
});

describe('assigning terminals', () => {
  it('shows a terminal in a pane, one terminal in at most one pane', () => {
    expect(assignTerminal(state(2, ['a', null]), 1, 'b').slots).toEqual(['a', 'b']);
    // b is shown in pane 1 already: the panes swap.
    expect(assignTerminal(state(2, ['a', 'b']), 0, 'b').slots).toEqual(['b', 'a']);
    // moving into an empty pane leaves the old one empty
    expect(assignTerminal(state(3, ['a', 'b', null]), 2, 'a').slots).toEqual([null, 'b', 'a']);
  });

  it('empties a pane', () => {
    expect(assignTerminal(state(2, ['a', 'b']), 0, null).slots).toEqual([null, 'b']);
  });

  it('ignores panes that do not exist', () => {
    const s = state(2, ['a', 'b']);
    expect(assignTerminal(s, 2, 'c')).toBe(s);
    expect(assignTerminal(s, -1, 'c')).toBe(s);
    expect(assignTerminal(s, 0.5, 'c')).toBe(s);
    expect(assignTerminal(s, 0, 'a')).toBe(s);
  });

  it('focuses a pane', () => {
    const s = state(3, ['a', 'b', 'c']);
    expect(focusPane(s, 2).focus).toBe(2);
    expect(focusPane(s, 3)).toBe(s);
    expect(focusPane(s, -1)).toBe(s);
    expect(focusPane(s, 0)).toBe(s);
  });

  it('reveals a terminal: focus its pane, else show it in the focused one', () => {
    const s = state(2, ['a', 'b'], 0);
    expect(revealTerminal(s, 'b').focus).toBe(1);
    expect(revealTerminal(s, 'b').slots).toEqual(['a', 'b']);
    const shown = revealTerminal(s, 'c');
    expect(shown.slots).toEqual(['c', 'b']);
    expect(shown.focus).toBe(0);
  });

  it('knows the focused terminal and where a terminal is shown', () => {
    const s = state(3, ['a', null, 'c'], 1);
    expect(focusedTerminal(s)).toBeNull();
    expect(focusedTerminal({ ...s, focus: 2 })).toBe('c');
    expect(paneOf(s, 'c')).toBe(2);
    expect(paneOf(s, 'zzz')).toBe(-1);
  });
});

describe('reconcile with the terminals that exist', () => {
  it('drops ended terminals — also ids that were never valid', () => {
    expect(reconcilePanes(state(3, ['a', 'dead', 'c']), ['a', 'c']).slots).toEqual(['a', null, 'c']);
    expect(reconcilePanes(state(2, ['ghost', 'a']), ['a']).slots).toEqual([null, 'a']);
  });

  it('fills empty panes with terminals no pane shows yet, in list order', () => {
    expect(reconcilePanes(state(3, ['b', null, null]), ['a', 'b', 'c', 'd']).slots).toEqual(['b', 'a', 'c']);
    expect(reconcilePanes(state(2, [null, null]), ['x']).slots).toEqual(['x', null]);
  });

  it('a pane whose terminal ended picks up another one that was not shown', () => {
    expect(reconcilePanes(state(2, ['a', 'b']), ['b', 'c']).slots).toEqual(['c', 'b']);
  });

  it('returns the same object when nothing changes, and copes with no terminals at all', () => {
    const s = state(2, ['a', 'b']);
    expect(reconcilePanes(s, ['a', 'b', 'c'])).toBe(s);
    expect(reconcilePanes(s, []).slots).toEqual([null, null]);
    expect(reconcilePanes(DEFAULT_PANES, [])).toBe(DEFAULT_PANES);
  });

  it('keeps the focus where it was', () => {
    expect(reconcilePanes(state(2, ['a', 'b'], 1), ['a']).focus).toBe(1);
  });
});

describe('launching into a pane', () => {
  it('prefers the focused pane when it is empty, then the first empty one, then the focused one', () => {
    expect(launchTarget(state(3, ['a', null, null], 2))).toBe(2);
    expect(launchTarget(state(3, ['a', 'b', null], 0))).toBe(2);
    expect(launchTarget(state(3, [null, 'b', 'c'], 1))).toBe(0);
    expect(launchTarget(state(2, ['a', 'b'], 1))).toBe(1);
  });
});

describe('pane grid', () => {
  it('lays out 1, 2, 3 (one tall pane) and 4 panes', () => {
    expect(paneGridClass(1)).toBe('grid-cols-1 grid-rows-1');
    expect(paneGridClass(2)).toBe('grid-cols-2 grid-rows-1');
    expect(paneGridClass(3)).toBe('grid-cols-2 grid-rows-2');
    expect(paneGridClass(4)).toBe('grid-cols-2 grid-rows-2');
    expect(paneCellClass(3, 0)).toBe('row-span-2');
    expect(paneCellClass(3, 1)).toBe('');
    expect(paneCellClass(4, 0)).toBe('');
  });
});

describe('persistence (per server)', () => {
  let store: Map<string, string>;

  /** Fresh modules over the given storage — as one page load. */
  async function load(initial: Record<string, string> = {}) {
    store = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
    return import('../src/features/code/paneStore');
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with one empty pane and remembers every change', async () => {
    const { usePanes } = await load();
    expect(usePanes.getState().count).toBe(1);
    usePanes.getState().setCount(3);
    usePanes.getState().assign(1, 'b');
    usePanes.getState().focusPane(1);
    expect(JSON.parse(store.get('agentdeck:panes') ?? 'null')).toEqual({ count: 3, slots: [null, 'b', null], focus: 1, cleared: [] });
  });

  it('restores the panes of the last page load', async () => {
    const { usePanes } = await load({ 'agentdeck:panes': JSON.stringify({ count: 2, slots: ['a', 'b'], focus: 1 }) });
    const s = usePanes.getState();
    expect([s.count, s.slots, s.focus]).toEqual([2, ['a', 'b'], 1]);
  });

  it('survives unreadable or hostile storage content', async () => {
    for (const raw of ['{broken', 'null', '[1,2]', JSON.stringify({ count: 'many', slots: { a: 1 }, focus: 'x' })]) {
      const { usePanes } = await load({ 'agentdeck:panes': raw });
      const s = usePanes.getState();
      expect(s.count).toBe(1);
      expect(s.slots).toEqual([null]);
      expect(s.focus).toBe(0);
    }
  });

  it('keeps one set of panes per server', async () => {
    const stored = JSON.stringify({ count: 2, slots: ['x', null], focus: 0 });
    const { usePanes } = await load({
      'agentdeck:servers': JSON.stringify({
        servers: [
          { id: 'default', name: '', base: '', token: null },
          { id: 'second', name: '', base: 'http://b', token: null },
        ],
        activeId: 'second',
      }),
      'agentdeck:panes': JSON.stringify({ count: 4, slots: [null, null, null, null], focus: 3 }),
      'agentdeck:panes@second': stored,
    });
    expect(usePanes.getState().count).toBe(2);
    usePanes.getState().focusPane(1);
    expect(JSON.parse(store.get('agentdeck:panes@second') ?? 'null').focus).toBe(1);
    expect(JSON.parse(store.get('agentdeck:panes') ?? 'null').count).toBe(4);
  });

  it('works without storage at all', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const { usePanes } = await import('../src/features/code/paneStore');
    usePanes.getState().setCount(2);
    expect(usePanes.getState().count).toBe(2);
  });
});

describe('sync with the active terminal', () => {
  /** A stand-in for the app store: a terminal list and the active terminal. */
  async function setup(initial: { panes?: PaneState; terminals?: string[]; loaded?: boolean } = {}) {
    const store = new Map<string, string>();
    if (initial.panes) store.set('agentdeck:panes', JSON.stringify(initial.panes));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
    const { create } = await import('zustand');
    const { usePanes } = await import('../src/features/code/paneStore');
    const { attachPaneSync } = await import('../src/features/code/paneSync');
    interface Fake {
      terminals: { id: string }[];
      terminalsLoaded: boolean;
      activeTerminalId: string | null;
      setActiveTerminal(id: string | null): void;
    }
    const app = create<Fake>()((set) => ({
      terminals: (initial.terminals ?? []).map((id) => ({ id })),
      terminalsLoaded: initial.loaded ?? false,
      // like the real store's refreshTerminals: the first terminal is active by default
      activeTerminalId: null,
      setActiveTerminal: (id) => set({ activeTerminalId: id }),
    }));
    const stop = attachPaneSync(app, usePanes);
    const list = (ids: string[], activeTerminalId?: string | null) =>
      app.setState({ terminals: ids.map((id) => ({ id })), terminalsLoaded: true, ...(activeTerminalId !== undefined ? { activeTerminalId } : {}) });
    return { app, panes: usePanes, stop, list };
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('the remembered focused terminal wins over the store default once the list arrives', async () => {
    const { app, panes, list } = await setup({ panes: state(2, ['b', 'c'], 1) });
    list(['a', 'b', 'c'], 'a'); // the store's own pick: the first terminal
    expect(panes.getState().slots).toEqual(['b', 'c']);
    expect(app.getState().activeTerminalId).toBe('c');
  });

  it('forgets remembered terminals that are gone and fills the panes with the ones that exist', async () => {
    const { app, panes, list } = await setup({ panes: state(2, ['gone', 'also-gone'], 0) });
    list(['x', 'y'], 'x');
    expect(panes.getState().slots).toEqual(['x', 'y']);
    expect(app.getState().activeTerminalId).toBe('x');
  });

  it('does nothing before the terminal list was loaded — an empty list must not wipe the panes', async () => {
    const { panes } = await setup({ panes: state(2, ['a', 'b'], 0) });
    expect(panes.getState().slots).toEqual(['a', 'b']);
  });

  it('works when the list is already there at start', async () => {
    const { app, panes } = await setup({ panes: state(2, ['a', 'b'], 1), terminals: ['a', 'b'], loaded: true });
    expect(panes.getState().slots).toEqual(['a', 'b']);
    expect(app.getState().activeTerminalId).toBe('b');
  });

  it('activating a terminal shows it: its pane gets the focus, else the focused pane takes it', async () => {
    const { app, panes, list } = await setup({ panes: state(2, ['a', 'b'], 0) });
    list(['a', 'b', 'c']);
    app.getState().setActiveTerminal('b');
    expect(panes.getState().focus).toBe(1);
    app.getState().setActiveTerminal('c');
    expect(panes.getState().slots).toEqual(['a', 'c']);
    expect(panes.getState().focus).toBe(1);
  });

  it('focusing a pane makes its terminal the active one', async () => {
    const { app, panes, list } = await setup({ panes: state(2, ['a', 'b'], 0) });
    list(['a', 'b']);
    panes.getState().focusPane(1);
    expect(app.getState().activeTerminalId).toBe('b');
    panes.getState().assign(1, 'a'); // swap: a is now in pane 1, focused
    expect(app.getState().activeTerminalId).toBe('a');
  });

  it('an unknown terminal id is never put into a pane', async () => {
    const { app, panes, list } = await setup({ panes: state(1, ['a'], 0) });
    list(['a']);
    app.getState().setActiveTerminal('not-a-terminal');
    expect(panes.getState().slots).toEqual(['a']);
  });

  it('a new terminal takes an empty pane; with none free it replaces the focused one', async () => {
    const { app, panes, list } = await setup({ panes: state(2, ['a', null], 0) });
    list(['a']);
    list(['a', 'b'], 'b');
    expect(panes.getState().slots).toEqual(['a', 'b']);
    expect(panes.getState().focus).toBe(1);
    list(['a', 'b', 'c'], 'c');
    expect(panes.getState().slots).toEqual(['a', 'c']);
    expect(app.getState().activeTerminalId).toBe('c');
  });

  it('an ended terminal leaves its pane; a spare one moves in', async () => {
    const { panes, list } = await setup({ panes: state(2, ['a', 'b'], 0) });
    list(['a', 'b', 'c']);
    list(['b', 'c']);
    expect(panes.getState().slots).toEqual(['c', 'b']);
  });

  it('more panes show the terminals that were not on screen', async () => {
    const { panes, list } = await setup({ panes: state(1, ['a'], 0) });
    list(['a', 'b', 'c']);
    panes.getState().setCount(3);
    expect(panes.getState().slots).toEqual(['a', 'b', 'c']);
  });

  it('stops syncing when detached', async () => {
    const { app, panes, list, stop } = await setup({ panes: state(1, ['a'], 0) });
    list(['a', 'b']);
    stop();
    app.getState().setActiveTerminal('b');
    expect(panes.getState().slots).toEqual(['a']);
  });
});
