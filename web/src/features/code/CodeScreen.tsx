import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import { ProjectPicker } from '../../components/ProjectPicker';

/**
 * Code tab (BridgeMind "Code mode", phone edition): real PTY shells on the
 * server, one xterm per open terminal. Hidden terminals stay mounted so their
 * scrollback survives tab switches; a key helper bar covers what phone
 * keyboards lack (Esc / Tab / Ctrl / arrows).
 */
export function CodeScreen() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const createTerminal = useAppStore((s) => s.createTerminal);
  const killTerminal = useAppStore((s) => s.killTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const refreshTerminals = useAppStore((s) => s.refreshTerminals);
  const toast = useAppStore((s) => s.toast);

  useEffect(() => {
    void refreshTerminals().catch(() => undefined);
  }, [refreshTerminals]);

  const project = projects.find((p) => p.id === activeProjectId);

  const spawn = async () => {
    if (!activeProjectId) {
      toast('info', 'Pick a project first — terminals live inside projects.');
      return;
    }
    try {
      await createTerminal(activeProjectId, 80, 24);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to open terminal');
    }
  };

  return (
    <div className="safe-t flex h-full flex-col">
      <header className="flex items-center gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] font-bold tracking-tight">Code</h1>
          <p className="truncate text-[12px] text-dim">{project?.name ?? 'No project'} · live shells</p>
        </div>
        <button
          type="button"
          aria-label="Open terminal"
          onClick={() => void spawn()}
          className="press tap flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-white"
          style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)' }}
        >
          <Plus size={15} /> Shell
        </button>
      </header>

      <div className="px-4 pb-2">
        <ProjectPicker />
      </div>

      {/* terminal tabs */}
      {terminals.length > 0 && (
        <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
          {terminals.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTerminal(t.id)}
              className={clsx(
                'press flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium',
                t.id === activeTerminalId
                  ? 'border-accent/50 bg-accent/15 text-ink'
                  : 'border-line bg-surface-2 text-dim',
              )}
            >
              shell {i + 1}
              <span
                role="button"
                aria-label={`Close shell ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void killTerminal(t.id);
                }}
                className="flex h-5 w-5 items-center justify-center rounded-full text-dim active:bg-white/10 active:text-ink"
              >
                <X size={12} />
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1 px-2 pb-2">
        {terminals.length === 0 ? (
          <div className="glass flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-[15px] font-semibold">No shells open</p>
            <p className="max-w-[32ch] text-[13px] leading-relaxed text-dim">
              Open a shell in {project?.name ?? 'a project'} to run commands, watch agent logs or sign
              into a second agent account.
            </p>
          </div>
        ) : (
          terminals.map((t) => (
            <TerminalView key={t.id} id={t.id} visible={t.id === activeTerminalId} />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ xterm */

function TerminalView({ id, visible }: { id: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const endedRef = useRef(false);
  const [ended, setEnded] = useState<number | null>(null);

  useEffect(() => {
    endedRef.current = ended !== null;
  }, [ended]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0d0f14',
        foreground: '#e9ecf3',
        cursor: '#7c5cff',
        selectionBackground: '#7c5cff44',
      },
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      // zero-size host on first paint — the ResizeObserver fits later
    }

    const store = useAppStore.getState();
    let live = false;

    // Initial repaint: fetch the server-side replay snapshot; WS chunks that
    // race the fetch are dropped (they are already inside the snapshot).
    void api
      .terminal(id)
      .then(({ replay }) => {
        if (replay) term.write(replay);
        live = true;
      })
      .catch(() => {
        live = true;
      });

    const unsubscribe = store.subscribeTerminal(
      id,
      (data) => {
        if (live) term.write(data);
      },
      (code) => setEnded(code),
    );

    const input = term.onData((data) => {
      if (!endedRef.current) store.sendTerminalInput(id, data);
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        store.resizeTerminal(id, term.cols, term.rows);
      } catch {
        // host not measurable yet
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      input.dispose();
      unsubscribe();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className={clsx('absolute inset-0 flex flex-col', !visible && 'invisible')} aria-hidden={!visible}>
      <div ref={hostRef} className="glass min-h-0 flex-1 overflow-hidden p-1.5" style={{ background: '#0d0f14' }} />
      <KeyHelperBar onKey={(seq) => useAppStore.getState().sendTerminalInput(id, seq)} disabled={ended !== null} />
      {ended !== null && (
        <div className="absolute inset-x-0 bottom-14 mx-auto w-fit rounded-full border border-line bg-surface-2 px-4 py-1.5 text-[12px] text-dim">
          shell ended ({ended === -1 ? 'killed' : `code ${ended}`})
        </div>
      )}
    </div>
  );
}

/** Keys a phone soft keyboard can't send to a terminal. */
function KeyHelperBar({ onKey, disabled }: { onKey: (seq: string) => void; disabled: boolean }) {
  const [ctrl, setCtrl] = useState(false);
  const press = (label: string, seq: string) => {
    if (disabled) return;
    if (ctrl && /^[a-z]/i.test(seq)) {
      const c = seq.toLowerCase().charCodeAt(0) - 96;
      onKey(String.fromCharCode(c));
      setCtrl(false);
      return;
    }
    onKey(seq);
    if (ctrl) setCtrl(false);
  };
  const keys: { label: string; seq: string }[] = [
    { label: 'Esc', seq: '\u001b' },
    { label: 'Tab', seq: '\t' },
    { label: '←', seq: '\u001b[D' },
    { label: '↓', seq: '\u001b[B' },
    { label: '↑', seq: '\u001b[A' },
    { label: '→', seq: '\u001b[C' },
  ];
  return (
    <div className="no-scrollbar mt-1.5 flex shrink-0 items-center gap-1.5 overflow-x-auto px-1 pb-[calc(env(safe-area-inset-bottom,0px)+4px)]">
      <button
        type="button"
        aria-pressed={ctrl}
        onClick={() => setCtrl((v) => !v)}
        className={clsx(
          'press flex h-9 shrink-0 items-center rounded-xl border px-3 text-[12px] font-semibold',
          ctrl ? 'border-accent/50 bg-accent/20 text-accent' : 'border-line bg-surface-2 text-dim',
        )}
      >
        Ctrl
      </button>
      {keys.map((k) => (
        <button
          key={k.label}
          type="button"
          onClick={() => press(k.label, k.seq)}
          className="press flex h-9 shrink-0 items-center rounded-xl border border-line bg-surface-2 px-3 text-[12px] font-semibold text-dim active:bg-surface-3 active:text-ink"
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
