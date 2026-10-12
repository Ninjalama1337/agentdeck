import { useSyncExternalStore } from 'react';
import type { Route } from '../store/route';
import { isDesktopApp } from '../util/desktop';

/**
 * Desktop layout: a wide window with a precise pointer (mouse, trackpad) —
 * in the Electron app and in a plain desktop browser alike. Phones, tablets,
 * the PWA and the APK keep the mobile layout.
 */
export const DESKTOP_MIN_WIDTH = 1024;

/**
 * Inside the desktop app the window is zoomed with Ctrl+Plus, which shrinks the
 * CSS width (a 1280px window at 200% is 640 CSS px) — that must not flip the
 * app into the phone layout, so the threshold is much lower there.
 */
export const DESKTOP_APP_MIN_WIDTH = 640;

/** The one rule that decides between the two layouts. */
export function isDesktopLayout(viewport: { width: number; finePointer: boolean; desktopApp?: boolean }): boolean {
  return viewport.finePointer && viewport.width >= (viewport.desktopApp ? DESKTOP_APP_MIN_WIDTH : DESKTOP_MIN_WIDTH);
}

const POINTER_QUERY = '(pointer: fine)';

function pointerList(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(POINTER_QUERY) : null;
  } catch {
    return null;
  }
}

/** The layout for the window as it is right now (false without a browser). */
export function desktopLayoutNow(): boolean {
  if (typeof window === 'undefined') return false;
  return isDesktopLayout({ width: window.innerWidth, finePointer: pointerList()?.matches ?? false, desktopApp: isDesktopApp() });
}

function subscribe(onChange: () => void): () => void {
  const pointer = pointerList();
  window.addEventListener('resize', onChange);
  pointer?.addEventListener?.('change', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    pointer?.removeEventListener?.('change', onChange);
  };
}

/** Reactive: true while the desktop layout applies (re-renders only when the answer flips). */
export function useDesktopLayout(): boolean {
  return useSyncExternalStore(subscribe, desktopLayoutNow, () => false);
}

/** How a screen sits in the desktop content area. */
export interface DesktopFrame {
  /** The area scrolls (list-like screens); false = the screen fills it and scrolls inside. */
  scroll: boolean;
  /** Max-width classes of the centered column ('' = the full width). */
  width: string;
}

/** Chat and Code use the whole window (split views, terminal panes); the rest is a readable column. */
export function desktopFrame(screen: Route['name']): DesktopFrame {
  switch (screen) {
    case 'chat':
    case 'code':
      return { scroll: false, width: '' };
    case 'home':
      return { scroll: true, width: 'max-w-6xl' };
    case 'team':
      return { scroll: true, width: 'max-w-3xl' };
    default:
      return { scroll: true, width: 'max-w-5xl' };
  }
}
