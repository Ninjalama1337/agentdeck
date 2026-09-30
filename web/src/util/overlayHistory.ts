/**
 * System-back support for overlays (sheets, modals).
 *
 * When an overlay opens it pushes a sentinel history entry; the Android
 * back gesture / hardware button (and browser back) then pops that entry and
 * closes the topmost overlay instead of leaving the page. Closing via
 * X / backdrop / drag runs the reverse: our sentinel is popped silently so
 * the next back press still targets the page below the overlay.
 */

interface OverlayEntry {
  id: number;
  close: () => void;
}

let seq = 0;
const stack: OverlayEntry[] = [];
let suppressPop = false;
let installed = false;

function onPopState() {
  if (suppressPop) {
    suppressPop = false;
    return;
  }
  // A sentinel entry was popped — close the topmost overlay. If the entry
  // popped wasn't ours (hash navigation), closing the top overlay is still
  // the sanest interpretation of "back" while an overlay covers the app.
  const entry = stack.pop();
  if (entry) entry.close();
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('popstate', onPopState);
}

/**
 * Call when an overlay becomes visible. The close callback fires on system
 * back. Returns a disposer to call on close/unmount (idempotent).
 */
export function registerOverlayClose(close: () => void): () => void {
  install();
  const entry: OverlayEntry = { id: ++seq, close };
  stack.push(entry);
  try {
    window.history.pushState({ adOverlay: entry.id }, '');
  } catch {
    /* history unavailable in exotic embeds — back support degrades gracefully */
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    // Remove our own sentinel without re-triggering the close path — but only
    // if it is still the topmost entry (another overlay may own the newer one).
    if (window.history.state?.adOverlay === entry.id) {
      suppressPop = true;
      try {
        window.history.back();
      } catch {
        suppressPop = false;
      }
    }
  };
}
