/**
 * Desktop keyboard shortcuts: Ctrl/Cmd+1…6 jump to the tabs, Ctrl/Cmd+, opens
 * Settings, Ctrl/Cmd+K the project switcher, Ctrl/Cmd+P quick open. Matching
 * is pure; App.tsx wires it.
 */
import type { Route } from '../store/route';

/** Tab order shared by the sidebar, the tab bar and Ctrl/Cmd+1…6. */
export const TAB_ROUTES: Route[] = [
  { name: 'home' },
  { name: 'chat' },
  { name: 'agents' },
  { name: 'code' },
  { name: 'git' },
  { name: 'files' },
];

export type ShortcutAction = { type: 'route'; route: Route } | { type: 'project-switcher' } | { type: 'quick-open' };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * What a key press asks for, or null. `inTerminal`: the key was typed into a
 * terminal, where Ctrl+K is "kill line" — only the tab shortcuts apply there.
 *
 * Ctrl+1…5 are taken even inside a terminal, on purpose: xterm would turn
 * Ctrl+2/3/4/5 into NUL/ESC/FS/GS — control characters nobody types by hand —
 * so a terminal user loses nothing, and the tabs stay reachable from the keyboard.
 */
export function matchShortcut(e: KeyLike, opts: { inTerminal?: boolean } = {}): ShortcutAction | null {
  if (!(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey) || e.altKey) return null;
  // Quick open: Ctrl/Cmd+Shift+P everywhere, Ctrl/Cmd+P outside a terminal (where Ctrl+P is "previous command").
  if (e.key === 'p' || e.key === 'P') return e.shiftKey || !opts.inTerminal ? { type: 'quick-open' } : null;
  if (e.shiftKey) return null;
  if (/^[1-9]$/.test(e.key)) {
    const route = TAB_ROUTES[Number(e.key) - 1];
    return route ? { type: 'route', route } : null;
  }
  if (e.key === ',') return { type: 'route', route: { name: 'settings' } };
  if ((e.key === 'k' || e.key === 'K') && !opts.inTerminal) return { type: 'project-switcher' };
  return null;
}

/** "Ctrl 1" / "⌘1" label for the sidebar. */
export function shortcutLabel(key: string, mac: boolean): string {
  return mac ? `⌘${key}` : `Ctrl ${key}`;
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/** Event the project switcher in the sidebar listens for. */
export const OPEN_PROJECT_SWITCHER = 'agentdeck:project-switcher';
