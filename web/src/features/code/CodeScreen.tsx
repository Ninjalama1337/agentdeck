import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { TerminalInfo, TerminalPreset } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { InboxButton } from '../inbox/InboxSheet';
import { haptic } from '../../util/haptics';
import { LauncherGrid, LauncherSheet, rememberCommand, type LaunchSpec } from './Launcher';
import { TerminalView, type ModifierRef } from './TerminalView';
import { KeyBar } from './KeyBar';
import { ComposeBar } from './ComposeBar';
import { estimateSize, sendRaw, sendText } from './termInput';

/** Quick answers for agent permission prompts (Claude/Codex menus take digits). */
const QUICK_ANSWERS: { label: string; send: string; hint: string }[] = [
  { label: '1', send: '1', hint: 'Yes' },
  { label: '2', send: '2', hint: 'Always' },
  { label: '3', send: '3', hint: 'No' },
  { label: 'y', send: 'y', hint: '' },
  { label: 'n', send: 'n', hint: '' },
];

/**
 * Code tab: real PTYs on the server with one-tap agent launchers (Claude
 * Code, Codex, OpenCode, Gemini …), a phone-grade compose bar with
 * dictation, a key bar for what soft keyboards lack, and per-agent snippet
 * chips. Terminals ring the inbox when an agent waits for input.
 */
export function CodeScreen() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const presets = useAppStore((s) => s.terminalPresets);
  const pendingLaunch = useAppStore((s) => s.pendingLaunch);
  const createTerminal = useAppStore((s) => s.createTerminal);
  const killTerminal = useAppStore((s) => s.killTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const refreshTerminals = useAppStore((s) => s.refreshTerminals);
  const toast = useAppStore((s) => s.toast);
  const compose = usePrefs((s) => s.termCompose);

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const modifier: ModifierRef = useRef({ ctrl: false, alt: false });
  modifier.current = { ctrl, alt };

  useEffect(() => {
    void refreshTerminals().catch(() => undefined);
  }, [refreshTerminals]);

  const project = projects.find((p) => p.id === activeProjectId);
  const active = terminals.find((t) => t.id === activeTerminalId);
  const activePreset = useMemo(
    () => presets?.find((p) => p.id === active?.presetId),
    [presets, active?.presetId],
  );

  const launch = useCallback(
    async (spec: LaunchSpec, projectId = activeProjectId) => {
      if (!projectId) {
        toast('info', 'Pick a project first — terminals run inside a project.');
        return;
      }
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      try {
        await createTerminal(projectId, cols, rows, spec);
        if (spec.command) rememberCommand(spec.command);
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Failed to open terminal');
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

  const paste = async () => {
    if (!active) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendText(active.id, text, false);
    } catch {
      toast('warn', 'Clipboard not readable — long-press the compose field to paste');
    }
  };

  const onKey = (seq: string) => {
    if (!active) return;
    sendRaw(active.id, seq);
    setCtrl(false);
    setAlt(false);
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'project';

  return (
    <div className="flex h-full flex-col">
      {/* header: project switcher + inbox + new */}
      <header className="flex items-center gap-1 px-4 pb-1.5 pt-2">
        <ProjectSwitcher
          className="min-w-0 flex-1"
          subtitle={terminals.length ? `${terminals.length} live ${terminals.length === 1 ? 'terminal' : 'terminals'}` : 'Terminals & agents'}
        />
        <InboxButton />
        <button
          type="button"
          aria-label="New terminal"
          onClick={() => setLauncherOpen(true)}
          className="press btn-primary flex h-10 w-10 items-center justify-center rounded-full text-white"
        >
          <Plus size={20} />
        </button>
      </header>

      {/* terminal tabs */}
      {terminals.length > 0 && (
        <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 pb-2" role="tablist">
          {terminals.map((t) => (
            <TerminalTab
              key={t.id}
              term={t}
              preset={presets?.find((p) => p.id === t.presetId)}
              active={t.id === activeTerminalId}
              foreign={t.projectId !== activeProjectId ? projectName(t.projectId) : undefined}
              onSelect={() => {
                haptic();
                setActiveTerminal(t.id);
              }}
              onClose={() => void killTerminal(t.id)}
            />
          ))}
        </div>
      )}

      {terminals.length === 0 ? (
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <div className="mb-4 mt-1">
            <h2 className="text-[16px] font-semibold">Start an agent</h2>
            <p className="text-[12.5px] leading-relaxed text-dim">
              Runs the real CLI in a terminal on your machine, inside {project?.name ?? 'the project'}. You get a
              notification when it's waiting for you.
            </p>
          </div>
          <LauncherGrid onLaunch={(spec) => void launch(spec)} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          <div className="relative min-h-0 flex-1">
            {terminals.map((t) => (
              <TerminalView
                key={t.id}
                id={t.id}
                visible={t.id === activeTerminalId}
                modifier={modifier}
                onModifierUsed={() => {
                  setCtrl(false);
                  setAlt(false);
                }}
                onRestart={() => restart(t)}
                onClose={() => void killTerminal(t.id)}
              />
            ))}
          </div>

          {/* agent chips: permission answers + slash commands */}
          {active && activePreset?.kind === 'agent' && (
            <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto pt-1.5">
              {QUICK_ANSWERS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => {
                    haptic();
                    sendRaw(active.id, q.send);
                  }}
                  className="press flex h-8 shrink-0 items-center gap-1 rounded-full border border-line bg-white/[0.04] px-3 font-mono text-[12.5px] font-semibold"
                >
                  {q.label}
                  {q.hint && <span className="font-sans text-[11px] font-normal text-dim">{q.hint}</span>}
                </button>
              ))}
              <span className="mx-0.5 h-5 w-px shrink-0 bg-line" />
              {(activePreset.snippets ?? []).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    haptic();
                    sendText(active.id, s.text);
                  }}
                  className="press flex h-8 shrink-0 items-center rounded-full border px-3 font-mono text-[12px]"
                  style={{ borderColor: `${activePreset.accent}40`, color: activePreset.accent, background: `${activePreset.accent}12` }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          <KeyBar
            onKey={onKey}
            ctrl={ctrl}
            alt={alt}
            onToggleCtrl={() => setCtrl((v) => !v)}
            onToggleAlt={() => setAlt((v) => !v)}
            onPaste={() => void paste()}
            disabled={!active}
          />

          {compose && active && (
            <ComposeBar
              placeholder={activePreset?.kind === 'agent' ? `Message ${activePreset.label}…` : 'Type a command…'}
              onSend={(text) => sendText(active.id, text)}
            />
          )}
        </div>
      )}

      <LauncherSheet
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onLaunch={(spec) => void launch(spec)}
        projectName={project?.name}
      />
    </div>
  );
}

function TerminalTab({
  term,
  preset,
  active,
  foreign,
  onSelect,
  onClose,
}: {
  term: TerminalInfo;
  preset: TerminalPreset | undefined;
  active: boolean;
  foreign?: string;
  onSelect: () => void;
  onClose: () => void;
}) {
  const accent = preset?.accent ?? '#99A1B3';
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirming]);
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
        {term.attention ? (
          <span className="attention-dot" aria-label="Waiting for you" />
        ) : (
          <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
        )}
        <span className="max-w-[140px] truncate">
          {term.title ?? 'shell'}
          {foreign && <span className="text-dim"> · {foreign}</span>}
        </span>
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
