import { useCallback, useEffect, useState } from 'react';
import { FileDiff, GitFork, GitMerge, Loader2, SquareTerminal, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { GitDiffResponse, WorktreeInfo } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { relTime } from '../../util/format';
import { haptic } from '../../util/haptics';
import { DiffView } from './DiffView';

/**
 * Results of parallel runs (see ParallelSheet): one card per agent worktree
 * with its changes; merge the best into the checkout, discard the rest.
 */
export function WorktreesSection({ projectId, onMerged }: { projectId: string; onMerged: () => void }) {
  const terminals = useAppStore((s) => s.terminals);
  const filesVersion = useAppStore((s) => s.filesVersion[projectId] ?? 0);
  const [list, setList] = useState<WorktreeInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; action: 'merge' | 'discard' } | null>(null);
  const [diffFor, setDiffFor] = useState<WorktreeInfo | null>(null);

  const load = useCallback(() => {
    void api
      .worktrees(projectId)
      .then(setList)
      .catch(() => setList([]));
  }, [projectId]);

  // Refresh while agents work: file events, terminals coming and going, and every 20 s.
  useEffect(() => {
    load();
    const t = window.setInterval(load, 20_000);
    return () => window.clearInterval(t);
  }, [load, filesVersion, terminals.length]);

  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  if (!list || list.length === 0) return null;

  const run = async (wt: WorktreeInfo, action: 'merge' | 'discard') => {
    if (confirm?.name !== wt.name || confirm.action !== action) {
      setConfirm({ name: wt.name, action });
      return;
    }
    setConfirm(null);
    setBusy(wt.name);
    const store = useAppStore.getState();
    try {
      if (action === 'merge') {
        await api.applyWorktree(projectId, wt.name);
        haptic('success');
        store.toast('info', `Merged ${wt.label}'s work — discard the other runs when you're done`);
        store.bumpFilesVersion(projectId);
        onMerged();
      } else {
        await api.removeWorktree(projectId, wt.name);
        store.toast('info', `Discarded ${wt.label}'s worktree`);
        void store.refreshTerminals();
      }
      load();
    } catch (err) {
      store.toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Runs of one prompt belong together.
  const groups = new Map<string, WorktreeInfo[]>();
  for (const wt of list) groups.set(wt.prompt, [...(groups.get(wt.prompt) ?? []), wt]);

  return (
    <section className="glass flex flex-col gap-3 p-3.5">
      <h3 className="flex items-center gap-2 text-[13.5px] font-semibold">
        <GitFork size={15} className="text-accent" /> Parallel runs
      </h3>
      {[...groups.entries()].map(([prompt, runs]) => (
        <div key={prompt} className="flex flex-col gap-2">
          <p className="line-clamp-2 text-[12.5px] text-dim">“{prompt}”</p>
          {runs.map((wt) => {
            const live = wt.terminalId && terminals.some((t) => t.id === wt.terminalId);
            const s = wt.stats;
            return (
              <div key={wt.name} className="rounded-xl border border-line bg-white/[0.03] p-2.5">
                <div className="flex items-center gap-2">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', live ? 'bg-ok pulse-dot' : 'bg-white/20')} title={live ? 'Agent running' : 'Agent ended'} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{wt.label}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-dim">
                    {wt.missing ? (
                      'folder missing'
                    ) : wt.merged ? (
                      <span className="font-semibold text-ok">✓ merged</span>
                    ) : s && s.files ? (
                      <>
                        <span className="text-ok">+{s.add}</span> <span className="text-danger">−{s.del}</span> · {s.files} {s.files === 1 ? 'file' : 'files'}
                      </>
                    ) : (
                      'no changes yet'
                    )}
                  </span>
                </div>
                <p className="mt-0.5 truncate pl-4 font-mono text-[10.5px] text-dim">
                  {wt.branch} · {relTime(wt.createdAt)}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
                  <ActionButton icon={FileDiff} label="Diff" onClick={() => setDiffFor(wt)} disabled={!!wt.missing} />
                  {live && <ActionButton icon={SquareTerminal} label="Terminal" onClick={() => useAppStore.getState().openTarget(`terminal:${wt.terminalId}`)} />}
                  {!wt.merged && (
                    <ActionButton
                      icon={busy === wt.name ? Loader2 : GitMerge}
                      label={confirm?.name === wt.name && confirm.action === 'merge' ? 'Tap to merge' : 'Merge'}
                      accent
                      onClick={() => void run(wt, 'merge')}
                      disabled={busy !== null || !!wt.missing || !s?.files}
                    />
                  )}
                  <ActionButton
                    icon={Trash2}
                    label={
                      confirm?.name === wt.name && confirm.action === 'discard'
                        ? wt.merged
                          ? 'Tap to clean up'
                          : 'Tap to discard'
                        : wt.merged
                          ? 'Clean up'
                          : 'Discard'
                    }
                    danger={!wt.merged}
                    onClick={() => void run(wt, 'discard')}
                    disabled={busy !== null}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <WorktreeDiffSheet projectId={projectId} worktree={diffFor} onClose={() => setDiffFor(null)} />
    </section>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  accent,
  danger,
}: {
  icon: typeof GitMerge;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'press flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium disabled:opacity-40',
        accent ? 'border-accent/40 bg-accent/15 text-accent' : danger ? 'border-danger/30 bg-danger/10 text-danger' : 'border-line bg-white/[0.04] text-ink',
      )}
    >
      <Icon size={13} className={Icon === Loader2 ? 'animate-spin' : undefined} /> {label}
    </button>
  );
}

function WorktreeDiffSheet({ projectId, worktree, onClose }: { projectId: string; worktree: WorktreeInfo | null; onClose: () => void }) {
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  useEffect(() => {
    setDiff(null);
    if (!worktree) return;
    api
      .worktreeDiff(projectId, worktree.name)
      .then(setDiff)
      .catch((err) => useAppStore.getState().toast('error', errorMessage(err)));
  }, [projectId, worktree]);
  return (
    <Sheet open={worktree !== null} onClose={onClose} title={worktree?.label} subtitle={worktree ? `${worktree.branch} vs ${worktree.base.slice(0, 8)}` : undefined}>
      {diff === null ? <div className="skeleton h-40" /> : <DiffView diff={diff.diff} truncated={diff.truncated} />}
    </Sheet>
  );
}
