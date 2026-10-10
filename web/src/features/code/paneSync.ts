/**
 * Ties the panes (paneStore) to the app's active terminal: the focused pane's
 * terminal is the active one, and activating a terminal anywhere (tab, Home,
 * notification) shows it in the panes. Runs for every layout — on a phone the
 * single pane is simply the selected terminal, which now survives a restart.
 *
 * Written against two small ports (the zustand stores satisfy them) so it can
 * be tested without the whole app store.
 */
import { focusedTerminal, type PaneState } from './paneLayout';

export interface AppSlice {
  terminals: { id: string }[];
  /** The terminal list came from the server at least once. */
  terminalsLoaded: boolean;
  activeTerminalId: string | null;
  setActiveTerminal(id: string | null): void;
}

export interface AppPort {
  getState(): AppSlice;
  subscribe(listener: (state: AppSlice, prev: AppSlice) => void): () => void;
}

export interface PanePort {
  getState(): PaneState & { reveal(id: string): void; reconcile(liveIds: readonly string[]): void };
  subscribe(listener: (state: PaneState, prev: PaneState) => void): () => void;
}

export function attachPaneSync(app: AppPort, panes: PanePort): () => void {
  let ready = false;

  const reconcile = () => panes.getState().reconcile(app.getState().terminals.map((t) => t.id));
  const activateFocused = () => {
    const id = focusedTerminal(panes.getState());
    if (id && id !== app.getState().activeTerminalId) app.getState().setActiveTerminal(id);
  };
  // The first list from the server settles the remembered panes; the terminal
  // they remembered wins over the store's "first terminal" default.
  const settle = () => {
    ready = true;
    reconcile();
    activateFocused();
  };

  const unsubscribeApp = app.subscribe((st, prev) => {
    if (!st.terminalsLoaded) return;
    if (!ready) return settle();
    if (st.terminals !== prev.terminals) reconcile();
    const id = st.activeTerminalId;
    if (id && id !== prev.activeTerminalId && st.terminals.some((t) => t.id === id)) panes.getState().reveal(id);
  });
  const unsubscribePanes = panes.subscribe((st, prev) => {
    if (!ready) return;
    // More panes than before: the new ones show terminals that are not on screen yet.
    if (st.count !== prev.count) reconcile();
    if (st.focus !== prev.focus || st.slots[st.focus] !== prev.slots[prev.focus]) activateFocused();
  });
  if (app.getState().terminalsLoaded) settle();

  return () => {
    unsubscribeApp();
    unsubscribePanes();
  };
}
