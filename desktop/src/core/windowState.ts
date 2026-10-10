export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
}

/** What `userData/window-state.json` holds. Position is the un-maximized one. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullScreen: boolean;
  displayId?: number;
  displayBounds?: Rect;
}

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const;
export const MIN_WINDOW_SIZE = { width: 800, height: 560 } as const;

/** Part of the title bar / window that must stay on a screen for the window to count as reachable. */
const MIN_VISIBLE = { width: 160, height: 80 } as const;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function rect(value: unknown): Rect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const [x, y, width, height] = [num(r.x), num(r.y), num(r.width), num(r.height)];
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

/** Untrusted JSON → state; null when it carries no usable size. */
export function normalizeWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const width = num(input.width);
  const height = num(input.height);
  if (width === undefined || height === undefined || width < 200 || height < 150) return null;
  const x = num(input.x);
  const y = num(input.y);
  const displayId = num(input.displayId);
  const displayBounds = rect(input.displayBounds);
  return {
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    width,
    height,
    maximized: input.maximized === true,
    fullScreen: input.fullScreen === true,
    ...(displayId !== undefined ? { displayId } : {}),
    ...(displayBounds ? { displayBounds } : {}),
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function area(r: { width: number; height: number }): number {
  return r.width * r.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export interface ResolvedWindowState {
  /** Undefined = let the window manager place it (centered). */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullScreen: boolean;
}

/**
 * Saved state → what to open the window with, on the screens that exist now.
 * Size is clamped to the screen, position is kept when enough of the window is
 * visible and otherwise moved onto the best-matching screen (monitor unplugged,
 * resolution changed).
 */
export function resolveWindowState(
  saved: WindowState | null,
  displays: readonly DisplayInfo[],
  primary: DisplayInfo,
): ResolvedWindowState {
  const screens = displays.length > 0 ? displays : [primary];
  if (!saved) {
    return {
      width: clamp(DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width, primary.workArea.width),
      height: clamp(DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height, primary.workArea.height),
      maximized: false,
      fullScreen: false,
    };
  }

  // Which screen was it on: same id and geometry, else the one it overlaps most.
  let target: DisplayInfo | undefined =
    saved.displayId !== undefined && saved.displayBounds
      ? screens.find((d) => d.id === saved.displayId && sameRect(d.bounds, saved.displayBounds as Rect))
      : undefined;
  const placed: Rect | undefined =
    saved.x !== undefined && saved.y !== undefined
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : undefined;
  if (!target && placed) {
    let best = 0;
    for (const d of screens) {
      const a = area(overlap(placed, d.workArea));
      if (a > best) {
        best = a;
        target = d;
      }
    }
  }
  const display = target ?? primary;

  const width = clamp(saved.width, MIN_WINDOW_SIZE.width, display.workArea.width);
  const height = clamp(saved.height, MIN_WINDOW_SIZE.height, display.workArea.height);
  const common = { width, height, maximized: saved.maximized, fullScreen: saved.fullScreen };
  if (!placed) return common;

  const visible = overlap({ ...placed, width, height }, display.workArea);
  const reachable =
    visible.width >= Math.min(MIN_VISIBLE.width, width) && visible.height >= Math.min(MIN_VISIBLE.height, height);
  if (reachable) {
    // Keep the title bar inside the work area even when part of the window hangs out.
    const x = clamp(placed.x, display.workArea.x - width + MIN_VISIBLE.width, display.workArea.x + display.workArea.width - MIN_VISIBLE.width);
    const y = clamp(placed.y, display.workArea.y, display.workArea.y + display.workArea.height - MIN_VISIBLE.height);
    return { ...common, x, y };
  }
  return {
    ...common,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
  };
}
