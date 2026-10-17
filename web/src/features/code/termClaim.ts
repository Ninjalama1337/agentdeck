/**
 * Which device sizes a terminal. A PTY has one size, and the server takes the
 * size that arrived last — from any device showing the terminal. A device
 * nobody is using (the desktop app left open, a browser tab behind others)
 * must not take it from the one in hand: a phone drawing a screen laid out
 * for 120 columns into 51 wraps every line into the next one.
 *
 * So a terminal sends its size on its own (layout change, tab shown,
 * reconnect) only while this device is in use, and every touch, key press or
 * return to the app sends it again.
 */

/**
 * Input this recent makes the device "in use". Short: what changes a phone's
 * size (rotating, switching tabs, pinching) is input itself, while a desktop
 * left open re-measures on its own (a terminal started from the phone).
 */
const IN_USE_MS = 30_000;

/** Opening the app counts as using it. */
let lastUse = typeof performance === 'undefined' ? 0 : performance.now();
const listeners = new Set<() => void>();
let installed = false;

function used(): void {
  lastUse = performance.now();
  for (const fn of listeners) fn();
}

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const opts = { capture: true, passive: true };
  document.addEventListener('pointerdown', used, opts);
  document.addEventListener('keydown', used, opts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') used();
  });
  window.addEventListener('focus', used);
  // Rotating the phone or resizing the window is the user's doing too.
  window.addEventListener('resize', used);
}

/** The user touched, typed into or returned to this device lately. */
export function deviceInUse(): boolean {
  return document.visibilityState === 'visible' && performance.now() - lastUse < IN_USE_MS;
}

/** Runs `fn` on every touch, key press, focus or return to the app. */
export function onDeviceUse(fn: () => void): () => void {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
