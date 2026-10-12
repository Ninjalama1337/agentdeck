import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowState,
  resolveWindowState,
  type DisplayInfo,
  type WindowState,
} from '../src/core/windowState';

const screen = (id: number, x: number, y: number, width: number, height: number): DisplayInfo => ({
  id,
  bounds: { x, y, width, height },
  workArea: { x, y: y + 28, width, height: height - 28 },
});
const main = screen(1, 0, 0, 1920, 1080);
const second = screen(2, 1920, 0, 2560, 1440);

const saved = (patch: Partial<WindowState> = {}): WindowState => ({
  x: 200,
  y: 150,
  width: 1100,
  height: 700,
  maximized: false,
  fullScreen: false,
  ...patch,
});

describe('normalizeWindowState', () => {
  it('accepts a complete state and rounds numbers', () => {
    expect(normalizeWindowState({ x: 10.4, y: 20, width: 1000.2, height: 800, maximized: true })).toEqual({
      x: 10, y: 20, width: 1000, height: 800, maximized: true, fullScreen: false,
    });
  });
  it('keeps the screen it was on', () => {
    const state = normalizeWindowState({ width: 900, height: 700, displayId: 2, displayBounds: { x: 1, y: 2, width: 3, height: 4 } });
    expect(state).toMatchObject({ displayId: 2, displayBounds: { x: 1, y: 2, width: 3, height: 4 } });
  });
  it('rejects garbage and absurd sizes', () => {
    expect(normalizeWindowState(null)).toBeNull();
    expect(normalizeWindowState('x')).toBeNull();
    expect(normalizeWindowState({ width: 'a', height: 5 })).toBeNull();
    expect(normalizeWindowState({ width: 50, height: 50 })).toBeNull();
  });
  it('drops a half position', () => {
    expect(normalizeWindowState({ x: 5, width: 900, height: 700 })).toEqual({ width: 900, height: 700, maximized: false, fullScreen: false });
  });
});

describe('resolveWindowState', () => {
  it('opens at the default size, centered by the window manager, without saved state', () => {
    expect(resolveWindowState(null, [main], main)).toEqual({ ...DEFAULT_WINDOW_SIZE, maximized: false, fullScreen: false });
  });

  it('fits the default size to a small screen', () => {
    const small = screen(1, 0, 0, 1100, 700);
    const r = resolveWindowState(null, [small], small);
    expect(r.width).toBe(1100);
    expect(r.height).toBe(672);
  });

  it('restores size, position and maximized state as saved', () => {
    expect(resolveWindowState(saved({ maximized: true }), [main], main)).toEqual({ x: 200, y: 150, width: 1100, height: 700, maximized: true, fullScreen: false });
    expect(resolveWindowState(saved({ fullScreen: true }), [main], main).fullScreen).toBe(true);
  });

  it('keeps a window on a second screen where it was', () => {
    const r = resolveWindowState(saved({ x: 2100, y: 100, displayId: 2, displayBounds: second.bounds }), [main, second], main);
    expect(r).toMatchObject({ x: 2100, y: 100 });
  });

  it('moves a window whose screen is gone onto the primary one, centered', () => {
    const r = resolveWindowState(saved({ x: 2100, y: 100, displayId: 2, displayBounds: second.bounds }), [main], main);
    expect(r.x).toBe(Math.round((1920 - 1100) / 2));
    expect(r.y).toBe(Math.round(28 + (1052 - 700) / 2));
  });

  it('pulls a window back that sits almost completely outside', () => {
    const r = resolveWindowState(saved({ x: 1900, y: 1070 }), [main], main);
    expect(r.x).toBeLessThanOrEqual(1920 - 160);
    expect(r.y).toBeLessThanOrEqual(1080 - 80);
  });

  it('never goes below the width where the web UI switches to its phone layout', () => {
    expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(1024);
  });

  it('shrinks a window that no longer fits, but never below the minimum', () => {
    const small = screen(1, 0, 0, 1280, 720);
    const r = resolveWindowState(saved({ width: 3000, height: 2000, x: 0, y: 0 }), [small], small);
    expect(r.width).toBe(1280);
    expect(r.height).toBe(692);
    const tiny = screen(1, 0, 0, 640, 400);
    const t = resolveWindowState(saved({ x: 0, y: 0 }), [tiny], tiny);
    expect(t.width).toBe(MIN_WINDOW_SIZE.width);
    expect(t.height).toBe(MIN_WINDOW_SIZE.height);
  });

  it('matches the screen by overlap when ids changed', () => {
    const r = resolveWindowState(saved({ x: 2200, y: 100, displayId: 7, displayBounds: { x: 0, y: 0, width: 1, height: 1 } }), [main, second], main);
    expect(r).toMatchObject({ x: 2200, y: 100 });
  });
});
