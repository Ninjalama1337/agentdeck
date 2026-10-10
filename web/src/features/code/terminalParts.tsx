/**
 * Pieces of the Code tab shared by the phone layout (CodeScreen) and the
 * desktop panes (CodePanes): terminal tabs, agent quick-answer chips and the
 * launch/restart logic.
 */
import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { clsx } from 'clsx';
import type { TerminalInfo, TerminalPreset } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { haptic } from '../../util/haptics';
import { rememberCommand, type LaunchSpec } from './Launcher';
import { estimateSize, sendRaw, sendText } from './termInput';

/** Quick answers for agent permission prompts (Claude/Codex menus take digits). */
const QUICK_ANSWERS: { label: string; send: string; hint: string }[] = [
  { label: '1', send: '1', hint: 'Yes' },
  { label: '2', send: '2', hint: 'Always' },
  { label: '3', send: '3', hint: 'No' },
  { label: 'y', send: 'y', hint: '' },
  { label: 'n', send: 'n', hint: '' },
];

/** Permission answers + the agent's slash-command snippets for the terminal `id`. */
export function AgentChips({ id, preset }: { id: string; preset: TerminalPreset }) {
  return (
    <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto pt-1.5">
      {QUICK_ANSWERS.map((q) => (
        <button
          key={q.label}
          type="button"
          onClick={() => {
            haptic();
            sendRaw(id, q.send);
          }}
          className="press flex h-8 shrink-0 items-center gap-1 rounded-full border border-line bg-white/[0.04] px-3 font-mono text-[12.5px] font-semibold"
        >
          {q.label}
          {q.hint && <span className="font-sans text-[11px] font-normal text-dim">{q.hint}</span>}
        </button>
      ))}
      <span className="mx-0.5 h-5 w-px shrink-0 bg-line" />
      {(preset.snippets ?? []).map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => {
            haptic();
            sendText(id, s.text);
          }}
          className="press flex h-8 shrink-0 items-center rounded-full border px-3 font-mono text-[12px]"
          style={{ borderColor: `${preset.accent}40`, color: preset.accent, background: `${preset.accent}12` }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Starting terminals: `launch` opens one in the active project (null when it
 * could not — the reason is toasted), `restart` replaces an ended one. Also
 * serves an app-shortcut launch (?launch=claude) once presets are known.
 */
export function useTerminalLauncher() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const presets = useAppStore((s) => s.terminalPresets);
  const pendingLaunch = useAppStore((s) => s.pendingLaunch);
  const createTerminal = useAppStore((s) => s.createTerminal);
  const killTerminal = useAppStore((s) => s.killTerminal);
  const toast = useAppStore((s) => s.toast);

  const launch = useCallback(
    async (spec: LaunchSpec, projectId = activeProjectId): Promise<TerminalInfo | null> => {
      if (!projectId) {
        toast('info', 'Pick a project first — terminals run inside a project.');
        return null;
      }
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      try {
        const terminal = await createTerminal(projectId, cols, rows, spec);
        if (spec.command) rememberCommand(spec.command);
        return terminal;
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Failed to open terminal');
        return null;
      }
    },
    [activeProjectId, createTerminal, toast],
  );

  // App shortcut (?launch=claude) → start that agent once presets are known.
  useEffect(() => {
    if (!pendingLaunch || presets === null || !activeProjectId) return;
    useAppStore.getState().setPendingLaunch(null);
    const preset = presets.find((p) => p.id === pendingLaunch);
    if (preset?.available) void launch({ presetId: preset.id });
    else toast('warn', `${pendingLaunch} is not installed on the server`);
  }, [pendingLaunch, presets, activeProjectId, launch, toast]);

  const restart = (t: TerminalInfo) => {
    void killTerminal(t.id);
    const custom = !t.presetId || t.presetId === 'custom';
    void launch(
      custom && t.command
        ? { command: t.command, ...(t.title ? { title: t.title } : {}) }
        : { presetId: t.presetId ?? 'shell', ...(t.variantId ? { variantId: t.variantId } : {}) },
      t.projectId,
    );
  };

  return { launch, restart };
}

const ATTENTION_LABEL: Record<NonNullable<TerminalInfo['attentionState']>, string> = {
  done: 'Done',
  waiting: 'Waiting for you',
  limit: 'Usage limit reached',
  error: 'Failed',
};

/** Status dot of a terminal: its agent's accent, or the attention state while it waits for the user. */
export function TerminalDot({ term, accent }: { term: TerminalInfo; accent: string }) {
  return term.attention ? (
    <span
      className={clsx('attention-dot shrink-0', term.attentionState && `attention-${term.attentionState}`)}
      aria-label={ATTENTION_LABEL[term.attentionState ?? 'waiting']}
    />
  ) : (
    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
  );
}

/** Two taps to end a terminal: the first arms the button for a moment. */
export function useConfirmEnd(): [boolean, (armed: boolean) => void] {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirming]);
  return [confirming, setConfirming];
}

export function TerminalTab({
  term,
  preset,
  active,
  foreign,
  pane,
  onSelect,
  onClose,
}: {
  term: TerminalInfo;
  preset: TerminalPreset | undefined;
  active: boolean;
  foreign?: string;
  /** Desktop: number of the pane showing this terminal. */
  pane?: number;
  onSelect: () => void;
  onClose: () => void;
}) {
  const accent = preset?.accent ?? '#99A1B3';
  const [confirming, setConfirming] = useConfirmEnd();
  return (
    <div
      role="tab"
      aria-selected={active}
      className={clsx(
        'press flex h-9 shrink-0 items-center rounded-full border pl-3 text-[12.5px] font-medium',
        active ? 'bg-surface-3 text-ink' : 'border-line bg-surface text-dim',
      )}
      style={active ? { borderColor: `${accent}66`, boxShadow: `0 0 0 1px ${accent}22` } : undefined}
    >
      <button type="button" onClick={onSelect} className="flex h-full items-center gap-2">
        <TerminalDot term={term} accent={accent} />
        <span className="max-w-[140px] truncate">
          {term.title ?? 'shell'}
          {foreign && <span className="text-dim"> · {foreign}</span>}
        </span>
        {pane !== undefined && (
          <span className="rounded-md bg-white/[0.08] px-1.5 font-mono text-[10.5px] text-dim" title={`Shown in pane ${pane + 1}`}>
            {pane + 1}
          </span>
        )}
      </button>
      {confirming ? (
        <button
          type="button"
          onClick={() => {
            haptic('warning');
            onClose();
          }}
          className="ml-1 mr-0.5 flex h-7 items-center rounded-full bg-danger px-2.5 text-[11.5px] font-semibold text-white"
        >
          End
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Close ${term.title ?? 'terminal'}`}
          onClick={() => setConfirming(true)}
          className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-full text-dim active:bg-white/10 active:text-ink"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
