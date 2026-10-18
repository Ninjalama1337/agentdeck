import { describe, expect, it } from 'vitest';
import { DESKTOP_APP_MIN_WIDTH, DESKTOP_MIN_WIDTH, desktopFrame, isDesktopLayout } from '../src/hooks/useDesktopLayout';
import { isMacPlatform, matchShortcut, shortcutLabel, TAB_ROUTES, type KeyLike } from '../src/util/shortcuts';

describe('desktop layout decision', () => {
  it('needs a wide window AND a precise pointer', () => {
    expect(isDesktopLayout({ width: 1440, finePointer: true })).toBe(true);
    expect(isDesktopLayout({ width: DESKTOP_MIN_WIDTH, finePointer: true })).toBe(true);
    expect(isDesktopLayout({ width: DESKTOP_MIN_WIDTH - 1, finePointer: true })).toBe(false);
    // A big tablet (touch) keeps the phone layout.
    expect(isDesktopLayout({ width: 1280, finePointer: false })).toBe(false);
    expect(isDesktopLayout({ width: 390, finePointer: false })).toBe(false);
    expect(isDesktopLayout({ width: 390, finePointer: true })).toBe(false);
  });

  it('inside the desktop app a zoomed window stays on the desktop layout', () => {
    // Ctrl+Plus shrinks the CSS width: a 1280px window at 200% is 640 CSS px.
    expect(isDesktopLayout({ width: 1067, finePointer: true, desktopApp: true })).toBe(true);
    expect(isDesktopLayout({ width: 889, finePointer: true, desktopApp: true })).toBe(true);
    expect(isDesktopLayout({ width: 640, finePointer: true, desktopApp: true })).toBe(true);
    expect(isDesktopLayout({ width: DESKTOP_APP_MIN_WIDTH - 1, finePointer: true, desktopApp: true })).toBe(false);
    // The same widths in a browser are phone layout — the 1024px rule is unchanged there.
    expect(isDesktopLayout({ width: 889, finePointer: true })).toBe(false);
    expect(isDesktopLayout({ width: 889, finePointer: true, desktopApp: false })).toBe(false);
    expect(isDesktopLayout({ width: 1067, finePointer: true })).toBe(true);
  });

  it('the desktop app still needs a precise pointer', () => {
    expect(isDesktopLayout({ width: 1280, finePointer: false, desktopApp: true })).toBe(false);
  });

  it('lets chat and code use the whole window, the other screens a centered column', () => {
    expect(desktopFrame('chat')).toEqual({ scroll: false, width: '' });
    expect(desktopFrame('code')).toEqual({ scroll: false, width: '' });
    for (const screen of ['home', 'git', 'files', 'settings', 'team'] as const) {
      const frame = desktopFrame(screen);
      expect(frame.scroll).toBe(true);
      expect(frame.width).toMatch(/^max-w-/);
    }
  });
});

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keyboard shortcuts', () => {
  it('Ctrl/Cmd+1…6 jump to the tabs in sidebar order', () => {
    expect(TAB_ROUTES.map((r) => r.name)).toEqual(['home', 'chat', 'agents', 'code', 'git', 'files']);
    TAB_ROUTES.forEach((route, i) => {
      expect(matchShortcut(key(String(i + 1), { ctrlKey: true }))).toEqual({ type: 'route', route });
      expect(matchShortcut(key(String(i + 1), { metaKey: true }))).toEqual({ type: 'route', route });
    });
    expect(matchShortcut(key('7', { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key('0', { ctrlKey: true }))).toBeNull();
  });

  it('ignores keys without exactly one of Ctrl/Cmd, and combinations with Alt or Shift', () => {
    expect(matchShortcut(key('1'))).toBeNull();
    expect(matchShortcut(key('1', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(key('1', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(key('1', { ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('opens settings and the project switcher — but never steals Ctrl+K from a terminal', () => {
    expect(matchShortcut(key(',', { ctrlKey: true }))).toEqual({ type: 'route', route: { name: 'settings' } });
    expect(matchShortcut(key('k', { ctrlKey: true }))).toEqual({ type: 'project-switcher' });
    expect(matchShortcut(key('K', { metaKey: true }))).toEqual({ type: 'project-switcher' });
    expect(matchShortcut(key('k', { ctrlKey: true }), { inTerminal: true })).toBeNull();
    // The tab shortcuts still work inside a terminal.
    expect(matchShortcut(key('4', { ctrlKey: true }), { inTerminal: true })).toEqual({ type: 'route', route: { name: 'code' } });
  });

  it('labels the shortcuts per platform', () => {
    expect(shortcutLabel('2', false)).toBe('Ctrl 2');
    expect(shortcutLabel('2', true)).toBe('⌘2');
    expect(isMacPlatform()).toBe(false); // no navigator in the node test run
  });
});
