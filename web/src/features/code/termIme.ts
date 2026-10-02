/**
 * Soft-keyboard input for xterm on touch devices.
 *
 * Mobile IMEs (Gboard & co.) do not send keys, they edit xterm's hidden
 * textarea: compose a word, replace it with a suggestion, autocorrect the one
 * before it. xterm.js guesses what was typed by string-diffing that textarea
 * and resends the whole value whenever a word is replaced rather than
 * extended — "teh " corrected to "the " arrives as "teh the ".
 *
 * Here the textarea is the model instead: after every IME edit the terminal
 * gets exactly the difference to what it already received — DEL for what
 * the IME took back, then the new tail. IME events are kept away from xterm;
 * real key events (hardware keyboards, Enter, arrows) still go through it.
 */
import type { Terminal } from '@xterm/xterm';

const DEL = '\u007f';

/** Idle time before the textarea is emptied (limits how far back an IME can edit). */
const IDLE_RESET_MS = 2000;

/** Keystrokes that turn `sent` (what the terminal has) into `value` (the textarea). */
export function imeDiff(sent: string, value: string): string {
  let i = 0;
  const max = Math.min(sent.length, value.length);
  while (i < max && sent.charCodeAt(i) === value.charCodeAt(i)) i++;
  // Never split a surrogate pair: back off onto the pair's first half.
  if (i > 0 && i < Math.max(sent.length, value.length)) {
    const prev = sent.charCodeAt(i - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) i--;
  }
  const removed = Array.from(sent.slice(i)).length;
  return DEL.repeat(removed) + value.slice(i).replace(/\r?\n/g, '\r');
}

export function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Takes over IME input of `term` on touch devices; `send` receives the
 * keystrokes. Returns the disposer. Left alone in xterm's screen-reader mode,
 * which needs the textarea for itself.
 */
export function installMobileIme(term: Terminal, send: (data: string) => void): () => void {
  const textarea = term.textarea;
  const root = term.element;
  if (!textarea || !root || !isTouchDevice()) return () => undefined;

  let sent = textarea.value;
  let composing = false;
  // A real key is down: xterm sends it, the textarea edit it causes is not news.
  let nativeKey = false;
  let resetTimer: number | null = null;

  const active = () => !term.options.screenReaderMode;
  const cancelReset = () => {
    if (resetTimer !== null) window.clearTimeout(resetTimer);
    resetTimer = null;
  };
  // Emptying the field restarts the IME, so only at safe points: after Enter
  // or a navigation key, or once typing has paused — never mid-word.
  const scheduleReset = (delay: number) => {
    cancelReset();
    resetTimer = window.setTimeout(() => {
      resetTimer = null;
      if (composing || !active()) return;
      textarea.value = '';
      sent = '';
    }, delay);
  };

  const sync = () => {
    const value = textarea.value;
    const data = imeDiff(sent, value);
    sent = value;
    if (data) send(data);
    scheduleReset(data.endsWith('\r') ? 0 : IDLE_RESET_MS);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active()) return;
    cancelReset();
    if (e.keyCode === 229) {
      // "IME is handling this" — the edit follows as an input event.
      nativeKey = false;
      e.stopPropagation();
      return;
    }
    nativeKey = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!active() || e.keyCode === 229) return;
    nativeKey = false;
    sent = textarea.value;
    // Enter, arrows, Tab …: the line moved on, the buffer no longer mirrors it.
    scheduleReset(e.key.length === 1 || e.key === 'Backspace' ? IDLE_RESET_MS : 0);
  };
  const onInput = (e: Event) => {
    if (!active()) return;
    e.stopPropagation();
    // xterm sends pastes from the paste event; the field merely follows.
    const pasted = (e as InputEvent).inputType === 'insertFromPaste';
    if (nativeKey || pasted) sent = textarea.value;
    else sync();
  };
  const onComposition = (e: Event) => {
    if (!active()) return;
    e.stopPropagation();
    composing = e.type !== 'compositionend';
    if (composing) cancelReset();
    else scheduleReset(IDLE_RESET_MS);
  };
  const onBlur = () => {
    composing = false;
    nativeKey = false;
    scheduleReset(0);
  };

  // Capture on xterm's root: these run before xterm's own textarea listeners.
  const capture = { capture: true };
  root.addEventListener('keydown', onKeyDown, capture);
  root.addEventListener('keyup', onKeyUp, capture);
  root.addEventListener('input', onInput, capture);
  root.addEventListener('compositionstart', onComposition, capture);
  root.addEventListener('compositionupdate', onComposition, capture);
  root.addEventListener('compositionend', onComposition, capture);
  textarea.addEventListener('blur', onBlur);
  return () => {
    root.removeEventListener('keydown', onKeyDown, capture);
    root.removeEventListener('keyup', onKeyUp, capture);
    root.removeEventListener('input', onInput, capture);
    root.removeEventListener('compositionstart', onComposition, capture);
    root.removeEventListener('compositionupdate', onComposition, capture);
    root.removeEventListener('compositionend', onComposition, capture);
    textarea.removeEventListener('blur', onBlur);
    cancelReset();
  };
}
