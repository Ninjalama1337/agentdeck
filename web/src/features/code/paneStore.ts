/**
 * Desktop terminal panes (see paneLayout.ts) as a zustand store, kept per
 * server in localStorage so the Code tab comes back as it was left. Which
 * terminal is the app's active one is wired up in paneSync.ts.
 */
import { create } from 'zustand';
import { scopedKey } from '../../api/servers';
import {
  assignTerminal,
  DEFAULT_PANES,
  focusPane,
  normalizePanes,
  reconcilePanes,
  revealTerminal,
  setPaneCount,
  type PaneState,
} from './paneLayout';

/** The part of localStorage the panes need — injectable for tests. */
export interface PaneStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PaneStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Remembered panes; anything unreadable gives the default single pane. */
export function readPanes(key: string, storage: PaneStorage | null = browserStorage()): PaneState {
  try {
    const raw = storage?.getItem(key);
    return raw ? normalizePanes(JSON.parse(raw)) : DEFAULT_PANES;
  } catch {
    return DEFAULT_PANES;
  }
}

export function writePanes(key: string, state: PaneState, storage: PaneStorage | null = browserStorage()): void {
  try {
    storage?.setItem(key, JSON.stringify({ count: state.count, slots: state.slots, focus: state.focus }));
  } catch {
    /* storage unavailable */
  }
}

const PANES_KEY = scopedKey('agentdeck:panes');

interface PaneStore extends PaneState {
  setCount(count: number): void;
  focusPane(index: number): void;
  /** Show a terminal in a pane (null empties it). */
  assign(index: number, id: string | null): void;
  /** Focus the pane that shows the terminal, or show it in the focused pane. */
  reveal(id: string): void;
  /** Drop ended terminals, fill empty panes with terminals no pane shows. */
  reconcile(liveIds: readonly string[]): void;
}

export const usePanes = create<PaneStore>()((set, get) => {
  const apply = (change: (state: PaneState) => PaneState) => {
    const { count, slots, focus } = get();
    const before: PaneState = { count, slots, focus };
    const after = change(before);
    if (after === before) return;
    set(after);
  };
  return {
    ...readPanes(PANES_KEY),
    setCount: (count) => apply((s) => setPaneCount(s, count)),
    focusPane: (index) => apply((s) => focusPane(s, index)),
    assign: (index, id) => apply((s) => assignTerminal(s, index, id)),
    reveal: (id) => apply((s) => revealTerminal(s, id)),
    reconcile: (liveIds) => apply((s) => reconcilePanes(s, liveIds)),
  };
});

// Persist from the store itself, reading the state as it is when the listener
// runs: a listener (paneSync) may change the panes again while this one is called.
usePanes.subscribe(() => writePanes(PANES_KEY, usePanes.getState()));
