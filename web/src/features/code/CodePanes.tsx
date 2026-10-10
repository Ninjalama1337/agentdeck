import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Columns2, Grid2x2, LayoutPanelLeft, Plus, Square, SquareTerminal, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import type { TerminalInfo, TerminalPreset } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { LauncherGrid, LauncherSheet, type LaunchSpec } from './Launcher';
import { TerminalView, type ModifierRef } from './TerminalView';
import { AgentChips, TerminalDot, TerminalTab, useConfirmEnd, useTerminalLauncher } from './terminalParts';
import { launchTarget, paneCellClass, paneGridClass, paneOf, type PaneCount } from './paneLayout';
import { usePanes } from './paneStore';

/** Desktop terminals take real key presses — there is no sticky Ctrl/Alt. */
const NO_MODIFIER: ModifierRef = { current: { ctrl: false, alt: false } };
const NOOP = () => undefined;

const COUNT_OPTIONS: { count: PaneCount; label: string; icon: LucideIcon }[] = [
  { count: 1, label: 'One pane', icon: Square },
  { count: 2, label: 'Two panes', icon: Columns2 },
  { count: 3, label: 'Three panes', icon: LayoutPanelLeft },
  { count: 4, label: 'Four panes', icon: Grid2x2 },
];

/**
 * Code tab on the desktop: 1–4 panes in a grid, a live terminal in each.
 * Which terminal sits where (and the pane count) is remembered per server;
 * the focused pane is the app's active terminal (see paneSync.ts).
 */
export function CodePanes() {
  const terminals = useAppStore((s) => s.terminals);
  const presets = useAppStore((s) => s.terminalPresets);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const killTerminal = useAppStore((s) => s.killTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const refreshTerminals = useAppStore((s) => s.refreshTerminals);
  const { count, slots, focus } = usePanes();
  const { launch, restart } = useTerminalLauncher();
  /** Pane a new terminal is meant for while the launcher sheet is open. */
  const [launcherPane, setLauncherPane] = useState<number | null>(null);

  useEffect(() => {
    void refreshTerminals().catch(() => undefined);
  }, [refreshTerminals]);

  const state = { count, slots, focus };
  const project = projects.find((p) => p.id === activeProjectId);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'project';
  const byId = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const focusedId = slots[focus] ?? null;
  const focusedTerm = focusedId ? byId.get(focusedId) : undefined;
  const focusedPreset = presets?.find((p) => p.id === focusedTerm?.presetId);

  /** Starts a terminal and shows it in `pane`. */
  const launchInto = async (spec: LaunchSpec, pane: number) => {
    const term = await launch(spec);
    if (!term) return;
    const panes = usePanes.getState();
    panes.assign(pane, term.id);
    panes.focusPane(pane);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-5 pb-2 pt-3">
        <ProjectSwitcher
          className="min-w-0 flex-1"
          subtitle={terminals.length ? `${terminals.length} live ${terminals.length === 1 ? 'terminal' : 'terminals'}` : 'Terminals & agents'}
        />
        <PaneCountPicker count={count} onChange={(n) => usePanes.getState().setCount(n)} />
        <button
          type="button"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => setLauncherPane(launchTarget(state))}
          className="press btn-primary flex h-10 w-10 items-center justify-center rounded-full text-white"
        >
          <Plus size={20} />
        </button>
      </header>

      {terminals.length > 0 && (
        <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-5 pb-2" role="tablist" aria-label="Terminals">
          {terminals.map((t) => (
            <TerminalTab
              key={t.id}
              term={t}
              preset={presets?.find((p) => p.id === t.presetId)}
              active={t.id === focusedId}
              pane={count > 1 && paneOf(state, t.id) >= 0 ? paneOf(state, t.id) : undefined}
              foreign={t.projectId !== activeProjectId ? projectName(t.projectId) : undefined}
              onSelect={() => setActiveTerminal(t.id)}
              onClose={() => void killTerminal(t.id)}
            />
          ))}
        </div>
      )}

      {terminals.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <div className="mx-auto max-w-2xl">
            <div className="mb-4 mt-1">
              <h2 className="text-[16px] font-semibold">Start an agent</h2>
              <p className="text-[12.5px] leading-relaxed text-dim">
                Runs the real CLI in a terminal on your machine, inside {project?.name ?? 'the project'}. You get a
                notification when it's waiting for you.
              </p>
            </div>
            <LauncherGrid onLaunch={(spec) => void launchInto(spec, launchTarget(state))} />
          </div>
        </div>
      ) : (
        <>
          <div className={clsx('grid min-h-0 flex-1 gap-2 px-3', paneGridClass(count))}>
            {slots.map((id, index) => {
              const term = id ? byId.get(id) : undefined;
              return (
                <Pane
                  // Panes are fixed slots; the terminal in one changes.
                  key={index}
                  index={index}
                  count={count}
                  term={term}
                  preset={presets?.find((p) => p.id === term?.presetId)}
                  focused={index === focus}
                  terminals={terminals}
                  presets={presets}
                  slots={slots}
                  foreign={term && term.projectId !== activeProjectId ? projectName(term.projectId) : undefined}
                  onFocus={() => usePanes.getState().focusPane(index)}
                  onAssign={(termId) => usePanes.getState().assign(index, termId)}
                  onLaunch={() => setLauncherPane(index)}
                  onEnd={(t) => void killTerminal(t.id)}
                  onRestart={(t) => restart(t)}
                />
              );
            })}
          </div>
          <div className="shrink-0 px-4 pb-2">
            {focusedTerm && focusedPreset?.kind === 'agent' && <AgentChips id={focusedTerm.id} preset={focusedPreset} />}
          </div>
        </>
      )}

      <LauncherSheet
        open={launcherPane !== null}
        onClose={() => setLauncherPane(null)}
        onLaunch={(spec) => void launchInto(spec, launcherPane ?? launchTarget(usePanes.getState()))}
        projectName={project?.name}
      />
    </div>
  );
}

function PaneCountPicker({ count, onChange }: { count: PaneCount; onChange: (count: PaneCount) => void }) {
  return (
    <div role="radiogroup" aria-label="Number of panes" className="flex rounded-xl border border-line bg-bg-raise p-0.5">
      {COUNT_OPTIONS.map(({ count: n, label, icon: Icon }) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={count === n}
          aria-label={label}
          title={label}
          onClick={() => onChange(n)}
          className={clsx(
            'press flex h-8 w-9 items-center justify-center rounded-[10px] transition-colors',
            count === n ? 'bg-surface-3 text-ink' : 'text-dim hover:text-ink',
          )}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

function Pane({
  index,
  count,
  term,
  preset,
  focused,
  terminals,
  presets,
  slots,
  foreign,
  onFocus,
  onAssign,
  onLaunch,
  onEnd,
  onRestart,
}: {
  index: number;
  count: PaneCount;
  term: TerminalInfo | undefined;
  preset: TerminalPreset | undefined;
  focused: boolean;
  terminals: TerminalInfo[];
  presets: TerminalPreset[] | null;
  slots: (string | null)[];
  foreign: string | undefined;
  onFocus: () => void;
  onAssign: (id: string | null) => void;
  onLaunch: () => void;
  onEnd: (term: TerminalInfo) => void;
  onRestart: (term: TerminalInfo) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useConfirmEnd();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const accent = preset?.accent ?? '#99A1B3';

  return (
    <section
      aria-label={`Pane ${index + 1}`}
      onPointerDownCapture={onFocus}
      className={clsx(
        'relative flex min-h-0 min-w-0 flex-col rounded-2xl border bg-surface transition-colors',
        paneCellClass(count, index),
        focused && count > 1 ? 'border-accent/55 shadow-[0_0_0_1px_rgba(124,92,255,0.28)]' : 'border-line',
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 rounded-t-2xl border-b border-line pl-3 pr-1">
        {term ? (
          <>
            <TerminalDot term={term} accent={accent} />
            <span className="min-w-0 truncate text-[12.5px] font-medium">
              {term.title ?? 'shell'}
              {foreign && <span className="text-dim"> · {foreign}</span>}
            </span>
          </>
        ) : (
          <span className="text-[12.5px] text-dim">Empty pane</span>
        )}
        <span className="flex-1" />
        <div ref={menuRef} className="relative">
          <button
            type="button"
            aria-label={`Choose the terminal of pane ${index + 1}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="press flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-white/[0.08] hover:text-ink"
          >
            <ChevronDown size={15} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-8 z-30 w-64 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
            >
              {terminals.map((t) => {
                const at = slots.indexOf(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={t.id === term?.id}
                    onClick={() => {
                      setMenuOpen(false);
                      onAssign(t.id);
                    }}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.07]',
                      t.id === term?.id && 'bg-white/[0.05]',
                    )}
                  >
                    <TerminalDot term={t} accent={presets?.find((p) => p.id === t.presetId)?.accent ?? '#99A1B3'} />
                    <span className="min-w-0 flex-1 truncate">{t.title ?? 'shell'}</span>
                    {at >= 0 && at !== index && <span className="font-mono text-[10.5px] text-dim">pane {at + 1}</span>}
                  </button>
                );
              })}
              {terminals.length > 0 && <div className="my-1 h-px bg-line" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLaunch();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.07]"
              >
                <Plus size={14} className="text-dim" /> New terminal here
              </button>
              {term && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onAssign(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.07]"
                >
                  <X size={14} className="text-dim" /> Empty this pane
                </button>
              )}
            </div>
          )}
        </div>
        {term &&
          (confirming ? (
            <button
              type="button"
              onClick={() => onEnd(term)}
              className="flex h-7 items-center rounded-lg bg-danger px-2.5 text-[11.5px] font-semibold text-white"
            >
              End
            </button>
          ) : (
            <button
              type="button"
              aria-label={`End ${term.title ?? 'terminal'}`}
              title="End this terminal"
              onClick={() => setConfirming(true)}
              className="press flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-white/[0.08] hover:text-ink"
            >
              <X size={14} />
            </button>
          ))}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-2xl">
        {term ? (
          <TerminalView
            key={term.id}
            id={term.id}
            visible
            pane
            focused={focused}
            modifier={NO_MODIFIER}
            onModifierUsed={NOOP}
            onRestart={() => onRestart(term)}
            onClose={() => onEnd(term)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white/[0.04] text-dim">
              <SquareTerminal size={22} />
            </span>
            <p className="max-w-[30ch] text-[12.5px] leading-relaxed text-dim">
              Nothing running here. Start an agent or a shell, or show a running terminal from the menu above.
            </p>
            <button
              type="button"
              onClick={onLaunch}
              className="press btn-primary flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-semibold text-white"
            >
              <Plus size={15} /> New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
