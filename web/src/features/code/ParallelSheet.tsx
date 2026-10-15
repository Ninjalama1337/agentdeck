import { useEffect, useMemo, useState } from 'react';
import { GitFork, Loader2, Minus, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { Sheet } from '../../components/ui/Sheet';
import { useDesktopLayout } from '../../hooks/useDesktopLayout';
import { estimateSize } from './termInput';
import { PresetGlyph } from './Launcher';
import { usePanes } from './paneStore';

const MAX_AGENTS = 4;

/** Event that opens the parallel sheet (launcher button). */
export const OPEN_PARALLEL = 'agentdeck:parallel';

export function openParallel(): void {
  window.dispatchEvent(new Event(OPEN_PARALLEL));
}

/** Mounted once in the app; opens on {@link openParallel}. */
export function ParallelLauncher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_PARALLEL, show);
    return () => window.removeEventListener(OPEN_PARALLEL, show);
  }, []);
  return <ParallelSheet open={open} onClose={() => setOpen(false)} />;
}

/**
 * One prompt, several agents (after Orca's parallel worktrees): each agent
 * gets its own git worktree and branch, works on the same task, and the Git
 * tab compares the results and merges the best one.
 */
export function ParallelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const presets = useAppStore((s) => s.terminalPresets);
  const projectId = useAppStore((s) => s.activeProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const desktop = useDesktopLayout();
  const [prompt, setPrompt] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const eligible = useMemo(() => (presets ?? []).filter((p) => p.kind === 'agent' && p.available && p.promptArg), [presets]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const isRepo = project?.git !== undefined && project.git !== null;

  const change = (id: string, delta: number) =>
    setCounts((c) => {
      const next = Math.max(0, (c[id] ?? 0) + delta);
      if (delta > 0 && total >= MAX_AGENTS) return c;
      return { ...c, [id]: next };
    });

  const start = async () => {
    if (!projectId || !prompt.trim() || total < 1) return;
    setBusy(true);
    const store = useAppStore.getState();
    try {
      const agents = Object.entries(counts).flatMap(([presetId, n]) => Array.from({ length: n }, () => ({ presetId })));
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      const res = await api.startParallel({ projectId, prompt: prompt.trim(), agents, cols, rows, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await store.refreshTerminals();
      if (desktop) {
        // Side by side: one pane per agent.
        const panes = usePanes.getState();
        panes.setCount(Math.min(MAX_AGENTS, res.terminals.length));
        res.terminals.forEach((t, i) => panes.assign(i, t.id));
        panes.focusPane(0);
      }
      if (res.terminals[0]) store.setActiveTerminal(res.terminals[0].id);
      store.navigate({ name: 'code' });
      store.toast('info', `${res.terminals.length} agents started — compare their work in the Git tab`);
      setPrompt('');
      setCounts({});
      onClose();
    } catch (err) {
      store.toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Run in parallel" subtitle="Same task, several agents — each in its own git worktree">
      {!isRepo ? (
        <p className="rounded-2xl border border-line bg-white/[0.03] px-4 py-3 text-[13px] text-dim">
          This needs a git repository with at least one commit. Set one up in the Git tab first.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="What should the agents do?"
            className="composer min-h-[96px] w-full resize-y rounded-2xl px-3.5 py-3 text-[14.5px] leading-snug outline-none placeholder:text-dim/60"
          />
          <div className="flex flex-col gap-1.5">
            <p className="px-1 text-[12px] text-dim">Agents ({total}/{MAX_AGENTS}) — the same agent may run more than once</p>
            {eligible.length === 0 && (
              <p className="text-[12.5px] text-dim">No agent on the server can take a start prompt (Claude Code, Codex, OpenCode, Gemini CLI).</p>
            )}
            {eligible.map((p) => {
              const n = counts[p.id] ?? 0;
              return (
                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2" style={n ? { borderColor: `${p.accent}88` } : undefined}>
                  <PresetGlyph preset={p} size={30} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{p.label}</span>
                  <button type="button" aria-label={`One ${p.label} less`} disabled={n === 0} onClick={() => change(p.id, -1)} className="press flex h-8 w-8 items-center justify-center rounded-lg border border-line text-dim disabled:opacity-30">
                    <Minus size={14} />
                  </button>
                  <span className="w-4 text-center text-[14px] font-semibold tabular-nums">{n}</span>
                  <button type="button" aria-label={`One ${p.label} more`} disabled={total >= MAX_AGENTS} onClick={() => change(p.id, 1)} className="press flex h-8 w-8 items-center justify-center rounded-lg border border-line text-dim disabled:opacity-30">
                    <Plus size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy || !prompt.trim() || total < 1}
            onClick={() => void start()}
            className="press btn-primary flex h-11 items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <GitFork size={16} />}
            Start {total || ''} {total === 1 ? 'agent' : 'agents'}
          </button>
          <p className="px-1 text-[11.5px] leading-relaxed text-dim">
            Each agent works on its own branch, starting from the current commit — uncommitted changes in your checkout are not
            included. The Git tab shows every result with its diff; merge the one you like, discard the others.
          </p>
        </div>
      )}
    </Sheet>
  );
}
