import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsDown, Copy, RotateCcw, TextSelect, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { api } from '../../api/client';
import { ctrlChar, isTerminalReply } from './termInput';
import { installMobileIme } from './termIme';
import { installTouchWheelScroll, sendWheelBurst, trackMouseMode, type MouseMode } from './termScroll';
import { openExternal } from '../../util/openExternal';
import { useIncomingFiles } from '../../util/incomingFiles';
import { attachToTerminal } from './termAttach';
import { copyText, installLongPress, installTouchSelect } from './termSelect';

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
  /** Desktop pane: the pane frame draws the border, the scroll buttons appear on hover. */
  pane?: boolean;
  /** Desktop pane: the terminal takes keyboard focus when this turns true. */
  focused?: boolean;
}

/**
 * One xterm bound to a server PTY. Stays mounted while hidden so scrollback
 * survives tab switches. The server's headless emulator answers terminal
 * queries, so replies xterm.js would generate are dropped here.
 */
export function TerminalView({ id, visible, modifier, onModifierUsed, onRestart, onClose, pane = false, focused = false }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mouseRef = useRef<MouseMode | null>(null);
  const endedRef = useRef(false);
  const [ended, setEnded] = useState<number | null>(null);
  /** Long-press menu, at a position inside the terminal. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Select mode: the finger selects text, lifting it copies. */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState('');
  const fontSize = usePrefs((s) => s.termFontSize);
  const compose = usePrefs((s) => s.termCompose);

  useEffect(() => {
    endedRef.current = ended !== null;
  }, [ended]);

  // Desktop pane: an image pasted or dropped onto the terminal goes to its agent
  // (on the phone the Code screen takes them for terminal and compose field alike).
  useIncomingFiles(hostRef, (files) => void attachToTerminal(id, files), pane && ended === null);

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
    term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));
    term.open(host);
    // Soft keyboards edit the textarea instead of sending keys (see termIme.ts).
    const disposeIme = installMobileIme(term, (data) => term.input(data, true));
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
    const disposeLongPress = installLongPress(host, (x, y) => {
      const rect = host.getBoundingClientRect();
      setMenu({ x: x - rect.left, y: y - rect.top });
    });
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
    let disposed = false;
    const pending: string[] = [];

    // Repaint from the server's serialized screen; chunks that race the fetch
    // are queued and replayed after it. Done at mount and after every socket
    // reconnect — output sent while the connection was down never arrived.
    const repaint = (reset: boolean) => {
      live = false;
      void api
        .terminal(id)
        .then(({ replay }) => {
          if (disposed) return;
          if (reset) term.reset();
          if (replay) term.write(replay);
        })
        .catch(() => undefined)
        .finally(() => {
          if (disposed) return;
          live = true;
          for (const chunk of pending.splice(0)) term.write(chunk);
        });
    };
    repaint(false);
    const unsubscribeReconnect = useAppStore.subscribe((st, prev) => {
      if (st.socketEpoch !== prev.socketEpoch) repaint(true);
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
      disposed = true;
      unsubscribeReconnect();
      unsubscribe();
      disposeTouchScroll();
      disposeLongPress();
      mouse.dispose();
      mouseRef.current = null;
      disposeIme();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A desktop pane that gets focus (click, tab, shortcut) types into its terminal.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused, id]);

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

  // Compose mode: tapping the terminal must not pop the soft keyboard. (A desktop
  // pane has no compose bar — it types into the terminal, and must keep the focus it was given.)
  useEffect(() => {
    const ta = termRef.current?.textarea;
    if (!ta) return;
    const composing = compose && !pane;
    ta.setAttribute('inputmode', composing ? 'none' : 'text');
    if (composing && document.activeElement === ta) ta.blur();
  }, [compose, pane]);

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

  // Select mode takes over the touches until text was copied or it is cancelled.
  useEffect(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!selecting || !term || !host) return;
    const dispose = installTouchSelect(term, host, setSelected, (text) => {
      setSelecting(false);
      void copy(text);
    });
    return () => {
      dispose();
      term.clearSelection();
      setSelected('');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  useEffect(() => {
    if (!visible) {
      setMenu(null);
      setSelecting(false);
    }
  }, [visible]);

  const copy = async (text: string) => {
    const toast = useAppStore.getState().toast;
    if (!text.trim()) return;
    if (await copyText(text)) toast('info', 'Copied to clipboard');
    else toast('error', 'Clipboard unavailable');
  };

  /** Text currently on screen, trailing blank lines dropped. */
  const screenText = () => {
    const term = termRef.current;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\s+$/, '');
  };

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
    <div className={clsx('absolute inset-0 flex flex-col', pane && 'group/pane', !visible && 'invisible')} aria-hidden={!visible}>
      <div
        ref={hostRef}
        className={clsx('term-host min-h-0 flex-1 overflow-hidden', !pane && 'rounded-[16px] border border-line')}
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
      <div
        className={clsx(
          // Centred on the right edge: the top-right corner is where TUIs put their close buttons.
          'absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-line bg-surface-2/90 p-1 shadow-lg backdrop-blur-sm',
          pane && 'opacity-0 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100',
        )}
      >
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
      {menu && (
        <>
          <div className="absolute inset-0 z-20" onPointerDown={() => setMenu(null)} />
          <div
            role="menu"
            className="absolute z-30 w-48 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
            style={{
              left: Math.max(8, Math.min(menu.x, (hostRef.current?.clientWidth ?? 0) - 200)),
              top: Math.max(8, Math.min(menu.y, (hostRef.current?.clientHeight ?? 0) - 100)),
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setSelecting(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[13.5px] active:bg-white/[0.07]"
            >
              <TextSelect size={15} className="text-dim" /> Select text
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void copy(screenText());
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[13.5px] active:bg-white/[0.07]"
            >
              <Copy size={15} className="text-dim" /> Copy screen
            </button>
          </div>
        </>
      )}
      {selecting && (
        <div className="absolute inset-x-3 top-3 z-20 flex items-center gap-2 rounded-2xl border border-accent/40 bg-surface-2/95 p-2 pl-3.5 shadow-lg">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">
            {selected.trim() ? selected.replace(/\s+/g, ' ') : 'Touch the first character, drag to the last — release copies'}
          </span>
          <button
            type="button"
            aria-label="Cancel selection"
            onClick={() => setSelecting(false)}
            className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-dim active:bg-white/10"
          >
            <X size={15} />
          </button>
        </div>
      )}
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
