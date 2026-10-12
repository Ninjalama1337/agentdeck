/**
 * Terminal panes of the desktop Code tab: 1–4 panes side by side, one
 * terminal each. Pure state transitions — no React, no storage — so the rules
 * (a terminal sits in at most one pane, dead terminals leave, nothing is lost
 * on bad input) are testable on their own.
 */

export const MAX_PANES = 4;
export type PaneCount = 1 | 2 | 3 | 4;

export interface PaneState {
  count: PaneCount;
  /** Terminal id per pane (length === count); null = empty pane. */
  slots: (string | null)[];
  /** Pane that receives new terminals; its terminal is the app's active one. */
  focus: number;
  /**
   * Panes the user emptied on purpose. They stay empty — no spare terminal
   * moves in — until a terminal is started or the user shows one there.
   */
  cleared: number[];
}

export const DEFAULT_PANES: PaneState = { count: 1, slots: [null], focus: 0, cleared: [] };

function toCount(value: unknown): PaneCount {
  const n = typeof value === 'number' && Number.isInteger(value) ? value : 1;
  return Math.min(MAX_PANES, Math.max(1, n)) as PaneCount;
}

function sameState(a: PaneState, b: PaneState): boolean {
  return (
    a.count === b.count &&
    a.focus === b.focus &&
    a.slots.every((id, i) => id === b.slots[i]) &&
    a.cleared.length === b.cleared.length &&
    a.cleared.every((index, i) => index === b.cleared[i])
  );
}

/** Reads untrusted JSON (storage, other versions) into a consistent state. */
export function normalizePanes(raw: unknown): PaneState {
  if (!raw || typeof raw !== 'object') return DEFAULT_PANES;
  const { count: rawCount, slots: rawSlots, focus: rawFocus, cleared: rawCleared } = raw as {
    count?: unknown;
    slots?: unknown;
    focus?: unknown;
    cleared?: unknown;
  };
  const count = toCount(rawCount);
  const input = Array.isArray(rawSlots) ? (rawSlots as unknown[]) : [];
  const seen = new Set<string>();
  const slots: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const id = input[i];
    if (typeof id === 'string' && id !== '' && !seen.has(id)) {
      seen.add(id);
      slots.push(id);
    } else {
      slots.push(null);
    }
  }
  const focus = typeof rawFocus === 'number' && Number.isInteger(rawFocus) && rawFocus >= 0 && rawFocus < count ? rawFocus : 0;
  // Only empty panes can be "cleared"; anything else in there is stale.
  const cleared = Array.isArray(rawCleared)
    ? [...new Set((rawCleared as unknown[]).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count && slots[i as number] === null))].sort((a, b) => a - b)
    : [];
  return { count, slots, focus, cleared };
}

/** Changes the number of panes; panes that stay keep their terminal, the others are dropped (the terminals keep running). */
export function setPaneCount(state: PaneState, requested: number): PaneState {
  const count = toCount(requested);
  if (count === state.count) return state;
  const slots = Array.from({ length: count }, (_, i) => state.slots[i] ?? null);
  return { count, slots, focus: Math.min(state.focus, count - 1), cleared: state.cleared.filter((i) => i < count) };
}

export function focusPane(state: PaneState, index: number): PaneState {
  if (!Number.isInteger(index) || index < 0 || index >= state.count || index === state.focus) return state;
  return { ...state, focus: index };
}

/**
 * Shows `id` in a pane. A terminal already shown elsewhere swaps places with
 * this pane's. `null` empties the pane on purpose: it stays empty (see `cleared`).
 */
export function assignTerminal(state: PaneState, index: number, id: string | null): PaneState {
  if (!Number.isInteger(index) || index < 0 || index >= state.count) return state;
  const isCleared = state.cleared.includes(index);
  if (state.slots[index] === id && (id !== null ? !isCleared : isCleared)) return state;
  const slots = [...state.slots];
  if (id !== null) {
    const from = slots.indexOf(id);
    if (from >= 0) slots[from] = slots[index] ?? null;
  }
  slots[index] = id;
  const cleared = id === null ? [...state.cleared.filter((i) => i !== index), index].sort((a, b) => a - b) : state.cleared.filter((i) => i !== index);
  return { ...state, slots, cleared };
}

/** Makes `id` the focused terminal: focuses the pane that shows it, else shows it in the focused pane. */
export function revealTerminal(state: PaneState, id: string): PaneState {
  const at = state.slots.indexOf(id);
  return at >= 0 ? focusPane(state, at) : assignTerminal(state, state.focus, id);
}

/**
 * Brings the panes in line with the terminals that exist: ended ones leave,
 * empty panes pick up terminals no pane shows yet (in list order). A pane the
 * user emptied on purpose only takes a `fresh` terminal — one that was just
 * started. Returns the same object when nothing changes.
 */
export function reconcilePanes(state: PaneState, liveIds: readonly string[], fresh: readonly string[] = []): PaneState {
  const alive = new Set(liveIds);
  const slots = state.slots.map((id) => (id !== null && alive.has(id) ? id : null));
  const shown = new Set(slots.filter((id): id is string => id !== null));
  const spare = liveIds.filter((id) => !shown.has(id));
  const cleared = new Set(state.cleared);
  const filled = slots.map((id, index) => {
    if (id !== null) return id;
    const at = cleared.has(index) ? spare.findIndex((candidate) => fresh.includes(candidate)) : spare.length > 0 ? 0 : -1;
    if (at < 0) return null;
    cleared.delete(index);
    return spare.splice(at, 1)[0] ?? null;
  });
  const next = { ...state, slots: filled, cleared: [...cleared].filter((i) => filled[i] === null).sort((a, b) => a - b) };
  return sameState(state, next) ? state : next;
}

/** Pane for a terminal that is about to be launched: the focused one if empty, else the first empty one, else the focused one. */
export function launchTarget(state: PaneState): number {
  if (state.slots[state.focus] === null) return state.focus;
  const empty = state.slots.indexOf(null);
  return empty >= 0 ? empty : state.focus;
}

/** The terminal of the focused pane — the app's active terminal. */
export function focusedTerminal(state: PaneState): string | null {
  return state.slots[state.focus] ?? null;
}

/** Pane the terminal is shown in, or -1. */
export function paneOf(state: PaneState, id: string): number {
  return state.slots.indexOf(id);
}

/** Grid classes for the pane container (Tailwind needs the full class names in source). */
export function paneGridClass(count: PaneCount): string {
  switch (count) {
    case 1:
      return 'grid-cols-1 grid-rows-1';
    case 2:
      return 'grid-cols-2 grid-rows-1';
    default:
      return 'grid-cols-2 grid-rows-2';
  }
}

/** Three panes: the first one is tall (left), the other two share the right column. */
export function paneCellClass(count: PaneCount, index: number): string {
  return count === 3 && index === 0 ? 'row-span-2' : '';
}
