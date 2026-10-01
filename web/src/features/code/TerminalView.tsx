import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsDown, RotateCcw, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { api } from '../../api/client';
import { ctrlChar, isTerminalReply } from './termInput';
import { installTouchWheelScroll, sendWheelBurst, trackMouseMode, type MouseMode } from './termScroll';

export const TERM_THEME = {
  background: '#0d0f14',
  foreground: '#e6e9f0',
  cursor: '#a78bfa',
  cursorAccent: '#0d0f14',
  selectionBackground: '#7c5cff55',
  black: '#1b1e27',
  red: '#ff6b81',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d6dae3',
  brightBlack: '#5b6478',
  brightRed: '#ff8fa3',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

/** Idle time before xterm's hidden textarea is emptied on touch devices. */
const IME_IDLE_CLEAR_MS = 2000;

/**
 * Mobile IMEs keep committed text in xterm's hidden textarea, and a later
 * keyCode 229 event can make xterm resend that stale buffer. Empty it only at
 * safe points — after Enter, or once typing has paused — never between two
 * keystrokes: rewriting the field mid-typing restarts the IME (the suggestion
 * strip flickers) and races xterm's own diff of the textarea. Left alone in
 * xterm's screen-reader mode.
 */
function installMobileImeBufferFix(term: Terminal): () => void {
  const textarea = term.textarea;
  const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
  if (!textarea || !touchDevice) return () => undefined;

  let composing = false;
  let clearTimer: number | null = null;
  const cancelClear = () => {
    if (clearTimer !== null) window.clearTimeout(clearTimer);
    clearTimer = null;
  };
  const scheduleClear = (delay: number) => {
    cancelClear();
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      if (composing || term.options.screenReaderMode) return;
      textarea.value = '';
    }, delay);
  };
  const onCompositionStart = () => {
    composing = true;
    cancelClear();
  };
  const onCompositionEnd = () => {
    composing = false;
    scheduleClear(IME_IDLE_CLEAR_MS);
  };
  const onKeyDown = () => cancelClear();
  const onKeyUp = (e: KeyboardEvent) => scheduleClear(e.key === 'Enter' ? 100 : IME_IDLE_CLEAR_MS);

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionend', onCompositionEnd);
  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('keyup', onKeyUp);
  return () => {
    textarea.removeEventListener('compositionstart', onCompositionStart);
    textarea.removeEventListener('compositionend', onCompositionEnd);
    textarea.removeEventListener('keydown', onKeyDown);
    textarea.removeEventListener('keyup', onKeyUp);
    cancelClear();
  };
}

/** Sticky modifier shared by key bar and direct typing ("Ctrl" then a key). */
export interface ModifierRef {
  current: { ctrl: boolean; alt: boolean };
}

interface Props {
  id: string;
  visible: boolean;
  modifier: ModifierRef;
  onModifierUsed: () => void;
  onRestart: () => void;
  onClose: () => void;
}

/**
 * One xterm bound to a server PTY. Stays mounted while hidden so scrollback
 * survives tab switches. The server's headless emulator answers terminal
 * queries, so replies xterm.js would generate are dropped here.
 */
export function TerminalView({ id, visible, modifier, onModifierUsed, onRestart, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mouseRef = useRef<MouseMode | null>(null);
  const endedRef = useRef(false);
  const [ended, setEnded] = useState<number | null>(null);
  const fontSize = usePrefs((s) => s.termFontSize);
  const compose = usePrefs((s) => s.termCompose);

  useEffect(() => {
    endedRef.current = ended !== null;
  }, [ended]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace',
      fontSize: usePrefs.getState().termFontSize,
      lineHeight: 1.12,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: false,
      theme: TERM_THEME,
      scrollback: 5000,
      smoothScrollDuration: 0,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const disposeImeFix = installMobileImeBufferFix(term);
    // tmux/TUI screens own the display: drags become wheel events instead of
    // panning a viewport that never has scrollback (see termScroll.ts).
    const mouse = trackMouseMode(term);
    const disposeTouchScroll = installTouchWheelScroll(
      term,
      host,
      () => term.buffer.active.type === 'alternate' && mouse.sgrActive(),
      (data) => {
        if (!endedRef.current) store.sendTerminalInput(id, data);
      },
    );
    mouseRef.current = mouse;
    const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
    if (viewport) {
      viewport.style.touchAction = 'pan-y';
      viewport.style.setProperty('-webkit-overflow-scrolling', 'touch');
      viewport.style.overscrollBehaviorY = 'contain';
    }
    termRef.current = term;
    fitRef.current = fit;
    const ta = term.textarea;
    if (ta) {
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('spellcheck', 'false');
    }
    try {
      fit.fit();
    } catch {
      // zero-size host on first paint — the ResizeObserver fits later
    }

    const store = useAppStore.getState();
    let live = false;
    const pending: string[] = [];

    // Initial repaint from the server's serialized screen; chunks that race
    // the fetch are queued and replayed after it.
    void api
      .terminal(id)
      .then(({ replay }) => {
        if (replay) term.write(replay);
      })
      .catch(() => undefined)
      .finally(() => {
        live = true;
        for (const chunk of pending.splice(0)) term.write(chunk);
      });

    const unsubscribe = store.subscribeTerminal(
      id,
      (data) => {
        if (live) term.write(data);
        else pending.push(data);
      },
      (code) => setEnded(code),
    );

    const input = term.onData((data) => {
      if (endedRef.current) return;
      if (isTerminalReply(data)) return;
      const mod = modifier.current;
      if ((mod.ctrl || mod.alt) && data.length === 1) {
        let out = data;
        if (mod.ctrl) out = ctrlChar(data) ?? data;
        if (mod.alt) out = `\u001b${out}`;
        onModifierUsed();
        store.sendTerminalInput(id, out);
        return;
      }
      store.sendTerminalInput(id, data);
    });

    let resizeTimer: number | null = null;
    let lastCols = term.cols;
    let lastRows = term.rows;
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          if (resizeTimer) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => store.resizeTerminal(id, term.cols, term.rows), 80);
        }
      } catch {
        return; // host not measurable yet
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      input.dispose();
      unsubscribe();
      disposeTouchScroll();
      mouse.dispose();
      mouseRef.current = null;
      disposeImeFix();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Font size (pref / pinch) → refit.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
      useAppStore.getState().resizeTerminal(id, term.cols, term.rows);
    } catch {
      /* hidden */
    }
  }, [fontSize, id]);

  // Compose mode: tapping the terminal must not pop the soft keyboard.
  useEffect(() => {
    const ta = termRef.current?.textarea;
    if (!ta) return;
    ta.setAttribute('inputmode', compose ? 'none' : 'text');
    if (compose && document.activeElement === ta) ta.blur();
  }, [compose]);

  // Seen while visible; refit when becoming visible (size may have changed).
  useEffect(() => {
    if (!visible) return;
    useAppStore.getState().markTerminalSeen(id);
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) useAppStore.getState().resizeTerminal(id, term.cols, term.rows);
      } catch {
        /* not measurable */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible, id]);

  // Pinch to zoom the font.
  const pinch = useRef<{ dist: number; size: number } | null>(null);
  const distance = (t: React.TouchList) => {
    const a = t[0];
    const b = t[1];
    return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
  };

  // On tmux/TUI screens the scroll buttons wheel the application instead of
  // the local viewport (which has no scrollback there).
  const inWheelMode = () => {
    const term = termRef.current;
    return !!term && term.buffer.active.type === 'alternate' && mouseRef.current?.sgrActive() === true;
  };
  const sendWheel = (down: boolean, ticks: number) => {
    const term = termRef.current;
    if (!term) return;
    sendWheelBurst(term, down, ticks, (data) => {
      if (!endedRef.current) useAppStore.getState().sendTerminalInput(id, data);
    });
  };

  return (
    <div className={clsx('absolute inset-0 flex flex-col', !visible && 'invisible')} aria-hidden={!visible}>
      <div
        ref={hostRef}
        className="term-host min-h-0 flex-1 overflow-hidden rounded-[16px] border border-line"
        style={{ background: TERM_THEME.background }}
        onTouchStart={(e) => {
          if (e.touches.length === 2) pinch.current = { dist: distance(e.touches), size: usePrefs.getState().termFontSize };
        }}
        onTouchMove={(e) => {
          if (!pinch.current || e.touches.length !== 2) return;
          const ratio = distance(e.touches) / (pinch.current.dist || 1);
          const next = Math.round(Math.min(22, Math.max(8, pinch.current.size * ratio)) * 2) / 2;
          if (next !== usePrefs.getState().termFontSize) usePrefs.getState().set('termFontSize', next);
        }}
        onTouchEnd={() => {
          pinch.current = null;
        }}
      />
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-xl border border-line bg-surface-2/90 p-1 shadow-lg backdrop-blur-sm">
        <button
          type="button"
          aria-label="Scroll terminal up one page"
          title="Scroll up"
          onClick={() => (inWheelMode() ? sendWheel(false, 8) : termRef.current?.scrollPages(-1))}
          className="press flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-white/10 hover:text-ink"
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          aria-label="Scroll terminal down one page"
          title="Scroll down"
          onClick={() => (inWheelMode() ? sendWheel(true, 8) : termRef.current?.scrollPages(1))}
          className="press flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-white/10 hover:text-ink"
        >
          <ChevronDown size={16} />
        </button>
        <button
          type="button"
          aria-label="Scroll terminal to latest output"
          title="Latest output"
          onClick={() => (inWheelMode() ? sendWheel(true, 60) : termRef.current?.scrollToBottom())}
          className="press flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-white/10 hover:text-ink"
        >
          <ChevronsDown size={15} />
        </button>
      </div>
      {ended !== null && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-2xl border border-line bg-surface-2/95 p-2 pl-3.5 shadow-lg">
          <span className="min-w-0 flex-1 text-[12.5px] text-dim">
            Session ended {ended === -1 ? '(closed)' : `(exit ${ended})`}
          </span>
          <button type="button" onClick={onRestart} className="press flex h-9 items-center gap-1.5 rounded-xl bg-accent/20 px-3 text-[12.5px] font-semibold text-accent">
            <RotateCcw size={13} /> Restart
          </button>
          <button type="button" aria-label="Close" onClick={onClose} className="press flex h-9 w-9 items-center justify-center rounded-xl text-dim active:bg-white/10">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
