import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Cpu, Download, Play, RefreshCw, Sparkles, TerminalSquare, GitFork } from 'lucide-react';
import { clsx } from 'clsx';
import { openParallel } from './ParallelSheet';
import type { TerminalPreset } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { haptic } from '../../util/haptics';
import { effortName, effortsFor, launchChoice, rememberLaunchChoice, type LaunchChoice } from './launchChoice';

export interface LaunchSpec {
  presetId?: string;
  variantId?: string;
  command?: string;
  title?: string;
  /** First prompt for an agent that takes one on start (preset.promptArg). */
  prompt?: string;
  /** Model and effort to start the agent with; omitted = what this device remembers for it. */
  model?: string;
  effort?: string;
}

const RECENT_KEY = 'agentdeck:recent-commands';

function recentCommands(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).slice(0, 6);
  } catch {
    return [];
  }
}

export function rememberCommand(cmd: string): void {
  try {
    const next = [cmd, ...recentCommands().filter((c) => c !== cmd)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

/** Monogram tile for a preset (brand-neutral, accent tinted). */
export function PresetGlyph({ preset, size = 40 }: { preset: Pick<TerminalPreset, 'id' | 'label' | 'accent' | 'kind'>; size?: number }) {
  const glyph = preset.kind === 'shell' ? '>_' : preset.label.replace(/[^A-Za-z]/g, '').slice(0, 2);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[13px] font-mono font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        color: preset.accent,
        background: `${preset.accent}1c`,
        boxShadow: `inset 0 0 0 1px ${preset.accent}38`,
      }}
    >
      {glyph}
    </span>
  );
}

/**
 * Agent launcher: one card per preset (Claude Code, Codex, OpenCode, Gemini,
 * shell, tools). Tap the card = new session; chips = continue/resume/yolo.
 */
export function LauncherGrid({
  onLaunch,
  compact,
  onBeforeParallel,
}: {
  onLaunch: (spec: LaunchSpec) => void;
  compact?: boolean;
  /** Runs before the parallel sheet opens (the launcher sheet closes itself). */
  onBeforeParallel?: () => void;
}) {
  const presets = useAppStore((s) => s.terminalPresets);
  const refresh = useAppStore((s) => s.refreshTerminalPresets);
  const [showMissing, setShowMissing] = useState(false);
  const [custom, setCustom] = useState('');
  const recent = useMemo(() => recentCommands(), []);

  if (presets === null) {
    return (
      <div className="grid grid-cols-1 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-[74px]" />
        ))}
      </div>
    );
  }

  const list = presets.length ? presets : [fallbackShell];
  const agents = list.filter((p) => p.kind === 'agent' && p.available);
  const tools = list.filter((p) => p.kind !== 'agent' && p.available);
  const missing = list.filter((p) => !p.available);

  const launch = (spec: LaunchSpec) => {
    haptic('medium');
    onLaunch(spec);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="section-title px-1">Agents</h3>
        {agents.some((p) => p.promptArg) && (
          <button
            type="button"
            onClick={() => {
              onBeforeParallel?.();
              openParallel();
            }}
            className="press tap flex items-center gap-3 rounded-2xl border border-dashed border-accent/45 bg-accent/[0.06] px-3.5 py-3 text-left"
          >
            <GitFork size={18} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">Run in parallel</span>
              <span className="block text-[12px] text-dim">Same task, several agents, separate worktrees — keep the best</span>
            </span>
          </button>
        )}
        {agents.length === 0 && (
          <p className="rounded-2xl border border-line bg-white/[0.03] px-4 py-3 text-[13px] text-dim">
            No agent CLI found on the server PATH. Install one below, then tap refresh.
          </p>
        )}
        {agents.map((p) => (
          <PresetCard key={p.id} preset={p} onLaunch={launch} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="section-title px-1">Shell & tools</h3>
        <div className="grid grid-cols-2 gap-2">
          {tools.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => launch({ presetId: p.id })}
              className="press glass-soft flex items-center gap-2.5 p-2.5 text-left active:bg-surface-3"
            >
              <PresetGlyph preset={p} size={34} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{p.label}</span>
                <span className="block truncate text-[11px] text-dim">{p.description}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {!compact && (
        <section className="flex flex-col gap-2">
          <h3 className="section-title px-1">Run a command</h3>
          <form
            className="composer flex items-center gap-1 rounded-2xl p-1 pl-3"
            onSubmit={(e) => {
              e.preventDefault();
              const cmd = custom.trim();
              if (!cmd) return;
              rememberCommand(cmd);
              launch({ command: cmd });
            }}
          >
            <TerminalSquare size={16} className="shrink-0 text-dim" />
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="npm run dev, pytest -x, htop…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-1.5 py-2.5 font-mono text-[13.5px] outline-none placeholder:text-dim/60"
            />
            <button type="submit" aria-label="Run" disabled={!custom.trim()} className="press btn-primary flex h-10 w-10 items-center justify-center rounded-xl text-white disabled:opacity-35">
              <Play size={15} fill="currentColor" />
            </button>
          </form>
          {recent.length > 0 && (
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
              {recent.map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => launch({ command: cmd })}
                  className="press flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3 font-mono text-[12px] text-dim"
                >
                  <Clock size={11} /> {cmd}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {missing.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <button type="button" onClick={() => setShowMissing((v) => !v)} className="press flex items-center gap-1 section-title">
              Not installed ({missing.length})
              <ChevronRight size={13} className={clsx('transition-transform', showMissing && 'rotate-90')} />
            </button>
            <button type="button" onClick={() => void refresh(true)} className="press flex items-center gap-1 text-[12px] font-medium text-accent">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          {showMissing &&
            missing.map((p) => (
              <div key={p.id} className="glass-soft flex items-center gap-3 p-2.5 opacity-80">
                <PresetGlyph preset={p} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{p.label}</span>
                  <span className="block truncate font-mono text-[11px] text-dim">{p.install ?? `${p.command} not on PATH`}</span>
                </span>
                {p.install && (
                  <button
                    type="button"
                    onClick={() => launch({ command: p.install, title: `Install ${p.label}` })}
                    className="press flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface-3 px-3 text-[12px] font-semibold"
                  >
                    <Download size={13} /> Install
                  </button>
                )}
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

function PresetCard({ preset, onLaunch }: { preset: TerminalPreset; onLaunch: (spec: LaunchSpec) => void }) {
  const extra = preset.variants.filter((v) => v.id !== 'new');
  const [choice, setChoice] = useState<LaunchChoice>(() => launchChoice(preset));
  // The model list can arrive later (agy asks the network) — a remembered pick applies then.
  useEffect(() => setChoice(launchChoice(preset)), [preset]);
  const pick = (next: LaunchChoice) => {
    setChoice(next);
    rememberLaunchChoice(preset.id, next);
  };
  const start = (variantId: string) => onLaunch({ presetId: preset.id, variantId, model: choice.model, effort: choice.effort });
  return (
    <div className="glass overflow-hidden p-0" style={{ boxShadow: `inset 3px 0 0 ${preset.accent}` }}>
      <button
        type="button"
        onClick={() => start('new')}
        className="press flex w-full items-center gap-3 px-3.5 pb-2.5 pt-3 text-left active:bg-white/[0.04]"
      >
        <PresetGlyph preset={preset} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{preset.label}</span>
          <span className="block truncate text-[12px] text-dim">{preset.description}</span>
        </span>
        <span
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-semibold text-white"
          style={{ background: preset.accent }}
        >
          <Play size={12} fill="currentColor" /> Start
        </span>
      </button>
      <LaunchOptions preset={preset} choice={choice} onChange={pick} />
      {extra.length > 0 && (
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3.5 pb-3">
          {extra.map((v) => (
            <button
              key={v.id}
              type="button"
              title={v.hint}
              onClick={() => start(v.id)}
              className={clsx(
                'press flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] font-medium',
                v.danger ? 'border-danger/35 bg-danger/10 text-danger' : 'border-line bg-white/[0.04] text-dim active:text-ink',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Model and effort for every start of this agent (Start and the variants),
 * remembered per agent. Native pickers: a long model list scrolls in the
 * phone's own dialog.
 */
function LaunchOptions({ preset, choice, onChange }: { preset: TerminalPreset; choice: LaunchChoice; onChange: (next: LaunchChoice) => void }) {
  const models = preset.modelArg ? (preset.models ?? []) : [];
  const efforts = effortsFor(preset, choice.model);
  if (models.length === 0 && efforts.length === 0) return null;
  const model = models.find((m) => m.id === choice.model);
  return (
    <div className="flex gap-1.5 px-3.5 pb-2.5">
      {models.length > 0 && (
        <OptionPill
          label="Model"
          value={choice.model ?? ''}
          text={model?.label ?? 'Default model'}
          icon={<Cpu size={12} className="shrink-0" />}
          accent={model ? preset.accent : undefined}
          onChange={(id) => {
            // An effort the new model does not take falls back to the default.
            const effort = choice.effort && effortsFor(preset, id || undefined).includes(choice.effort) ? choice.effort : undefined;
            onChange({ ...(id ? { model: id } : {}), ...(effort ? { effort } : {}) });
          }}
        >
          <option value="">Default model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.description && m.description !== m.label ? `${m.label} — ${m.description}` : m.label}
            </option>
          ))}
        </OptionPill>
      )}
      {efforts.length > 0 && (
        <OptionPill
          label="Effort"
          value={choice.effort ?? ''}
          text={choice.effort ? effortName(choice.effort) : 'Default effort'}
          icon={<Sparkles size={12} className="shrink-0" />}
          accent={choice.effort ? preset.accent : undefined}
          onChange={(level) => onChange({ ...(choice.model ? { model: choice.model } : {}), ...(level ? { effort: level } : {}) })}
        >
          <option value="">Default effort</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {effortName(level)}
            </option>
          ))}
        </OptionPill>
      )}
    </div>
  );
}

/** A chip that opens the platform's select. Tinted with the agent's colour once set. */
function OptionPill({
  label,
  value,
  text,
  icon,
  accent,
  onChange,
  children,
}: {
  label: string;
  value: string;
  text: string;
  icon: React.ReactNode;
  accent?: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={clsx(
        'press relative flex h-8 min-w-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium',
        accent ? 'text-ink' : 'border-line bg-white/[0.04] text-dim',
      )}
      style={accent ? { borderColor: `${accent}73`, background: `${accent}1f` } : undefined}
    >
      {icon}
      <span className="truncate">{text}</span>
      <ChevronDown size={12} className="shrink-0 opacity-70" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {children}
      </select>
    </label>
  );
}

const fallbackShell: TerminalPreset = {
  id: 'shell',
  label: 'Shell',
  description: 'Plain login shell in the project',
  kind: 'shell',
  command: '',
  accent: '#99A1B3',
  available: true,
  variants: [{ id: 'new', label: 'New', args: '' }],
};

export function LauncherSheet({
  open,
  onClose,
  onLaunch,
  projectName,
}: {
  open: boolean;
  onClose: () => void;
  onLaunch: (spec: LaunchSpec) => void;
  projectName?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="New terminal" subtitle={projectName ? `Runs in ${projectName}` : undefined}>
      <LauncherGrid
        onLaunch={(spec) => {
          onClose();
          onLaunch(spec);
        }}
        onBeforeParallel={onClose}
      />
    </Sheet>
  );
}
