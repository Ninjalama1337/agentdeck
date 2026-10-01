import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUp,
  Check,
  Download,
  GitBranch,
  GitCommitHorizontal,
  Github,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  Upload,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { GitBranches, GitChange, GitCommitInfo, GitDiffResponse, GithubRepo, ProjectGitInfo } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { InboxButton } from '../inbox/InboxSheet';
import { Sheet } from '../../components/ui/Sheet';
import { EmptyState } from '../../components/ui/EmptyState';
import { DictationHint, MicButton } from '../../components/MicButton';
import { useDictation } from '../../hooks/useDictation';
import { RepoPicker } from '../github/RepoPicker';
import { relTime } from '../../util/format';
import { haptic } from '../../util/haptics';
import { DiffView } from './DiffView';

const STATE_BADGE: Record<GitChange['state'], { letter: string; color: string }> = {
  modified: { letter: 'M', color: '#F59E0B' },
  added: { letter: 'A', color: '#10B981' },
  deleted: { letter: 'D', color: '#F43F5E' },
  renamed: { letter: 'R', color: '#4E8CFF' },
  copied: { letter: 'C', color: '#4E8CFF' },
  typechange: { letter: 'T', color: '#A78BFA' },
  untracked: { letter: 'U', color: '#2DD4BF' },
  conflict: { letter: '!', color: '#F43F5E' },
};

export function GitScreen() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  if (!activeProjectId) {
    return (
      <div className="flex min-h-full flex-col px-4 pb-8">
        <header className="py-4">
          <h1 className="text-[20px] font-bold tracking-tight">Git</h1>
        </header>
        <div className="glass">
          <EmptyState icon={GitBranch} title="No project selected" hint="Create or clone a project to see changes, branches and history." />
        </div>
        <CloneSection />
      </div>
    );
  }
  return <GitScreenInner key={activeProjectId} projectId={activeProjectId} />;
}

function GitScreenInner({ projectId }: { projectId: string }) {
  const projects = useAppStore((s) => s.projects);
  const agents = useAppStore((s) => s.agents);
  const upsertProject = useAppStore((s) => s.upsertProject);
  const toast = useAppStore((s) => s.toast);
  const filesVersion = useAppStore((s) => s.filesVersion[projectId] ?? 0);
  const project = projects.find((p) => p.id === projectId);

  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [status, setStatus] = useState<ProjectGitInfo | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<GitCommitInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [diffFor, setDiffFor] = useState<{ title: string; path?: string; hash?: string } | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);

  const dictation = useDictation(
    (t) => setMessage((m) => (m ? `${m} ${t}` : t)),
    (msg) => toast('error', msg),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await api.gitStatus(projectId);
      const isRepo = info && Object.keys(info).length > 0;
      setNotRepo(!isRepo);
      setStatus(isRepo ? info : null);
      if (!isRepo) {
        setChanges([]);
        return;
      }
      const project = useAppStore.getState().projects.find((p) => p.id === projectId);
      if (project) upsertProject({ ...project, git: info });
      const list = await api.gitChanges(projectId);
      setChanges(list);
      // Keep selection in sync: new files join, vanished files drop out.
      setSelected((prev) => {
        const paths = new Set(list.map((c) => c.path));
        if (prev.size === 0) return paths;
        const next = new Set([...prev].filter((p) => paths.has(p)));
        return next;
      });
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, toast, upsertProject]);

  useEffect(() => {
    void refresh();
  }, [refresh, filesVersion]);

  useEffect(() => {
    if (tab !== 'history' || notRepo) return;
    void api.gitLog(projectId, 60).then(setLog).catch(() => setLog([]));
  }, [tab, projectId, notRepo, status?.ahead]);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; message?: string } | void>) => {
    if (busy) return;
    setBusy(label);
    haptic();
    try {
      const res = await fn();
      if (res) {
        toast(res.ok ? 'info' : 'warn', (res.message ?? '').split('\n').slice(-2).join(' ') || label);
        haptic(res.ok ? 'success' : 'warning');
      }
    } catch (err) {
      toast('error', `${label}: ${errorMessage(err)}`);
      haptic('warning');
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const allSelected = changes !== null && changes.length > 0 && selected.size === changes.length;
  const selectedList = useMemo(() => (changes ?? []).filter((c) => selected.has(c.path)).map((c) => c.path), [changes, selected]);

  const commit = (push: boolean) =>
    run(push ? 'Commit & push' : 'Commit', async () => {
      if (!message.trim() || selectedList.length === 0) return;
      await api.gitCommit(projectId, {
        message: message.trim(),
        ...(allSelected ? { all: true } : { files: selectedList }),
      });
      setMessage('');
      if (!push) return { ok: true, message: 'Committed' };
      return api.gitPush(projectId);
    });

  const suggest = async () => {
    if (suggesting) return;
    const agentId = agents.claude?.available ? 'claude' : agents.codex?.available ? 'codex' : undefined;
    if (!agentId) {
      toast('warn', 'Needs Claude Code or Codex on the server');
      return;
    }
    setSuggesting(true);
    haptic();
    try {
      const res = await api.gitSuggestMessage(projectId, { agentId, ...(allSelected ? {} : { files: selectedList }) });
      setMessage(res.text);
      haptic('success');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  };

  const behind = status?.behind ?? 0;
  const ahead = status?.ahead ?? 0;

  return (
    <div className="flex min-h-full flex-col pb-28">
      <header className="appbar flex items-center gap-1 px-4 pb-2 pt-2">
        <ProjectSwitcher className="min-w-0 flex-1" subtitle={project?.git?.remote?.replace(/^https?:\/\/|\.git$/g, '') ?? 'Local repository'} />
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => void refresh()}
          className="press tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/[0.08]"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
        </button>
        <InboxButton />
      </header>

      {notRepo ? (
        <div className="px-4">
          <div className="glass">
            <EmptyState icon={GitBranch} title="Not a git repository" hint="Run `git init` in a terminal (Code tab) or clone a repo below." />
          </div>
          <CloneSection />
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4">
          {/* branch + sync */}
          <section className="glass flex flex-col gap-3 p-3.5">
            <button
              type="button"
              onClick={() => setBranchesOpen(true)}
              className="press flex items-center gap-2.5 text-left"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-blue/15 text-accent-blue">
                <GitBranch size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[14.5px] font-semibold">{status?.branch ?? '…'}</span>
                <span className="block text-[12px] text-dim">
                  {!status?.remote
                    ? 'No remote configured'
                    : ahead === 0 && behind === 0
                      ? 'In sync with remote'
                      : `${ahead} to push · ${behind} to pull`}
                </span>
              </span>
              <span className="text-[12px] font-medium text-accent">Switch</span>
            </button>
            <div className="grid grid-cols-3 gap-2">
              <SyncButton icon={<Download size={15} />} label="Pull" count={behind} busy={busy === 'Pull'} onClick={() => void run('Pull', () => api.gitPull(projectId))} />
              <SyncButton icon={<Upload size={15} />} label="Push" count={ahead} busy={busy === 'Push'} onClick={() => void run('Push', () => api.gitPush(projectId))} />
              <SyncButton icon={<RefreshCw size={15} />} label="Fetch" busy={busy === 'Fetch'} onClick={() => void run('Fetch', () => api.gitFetch(projectId))} />
            </div>
          </section>

          {/* segmented control */}
          <div className="grid grid-cols-2 rounded-2xl border border-line bg-surface p-1">
            {(['changes', 'history'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={clsx(
                  'press h-9 rounded-xl text-[13.5px] font-semibold',
                  tab === t ? 'bg-surface-3 text-ink shadow' : 'text-dim',
                )}
              >
                {t === 'changes' ? `Changes${changes?.length ? ` (${changes.length})` : ''}` : 'History'}
              </button>
            ))}
          </div>

          {tab === 'changes' ? (
            <>
              {changes === null ? (
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="skeleton h-12" />
                  ))}
                </div>
              ) : changes.length === 0 ? (
                <div className="glass flex flex-col items-center gap-1.5 px-6 py-8 text-center">
                  <Check size={24} className="text-ok" />
                  <p className="text-[14px] font-semibold">Working tree clean</p>
                  <p className="text-[12.5px] text-dim">Agent edits show up here live.</p>
                </div>
              ) : (
                <section className="glass overflow-hidden p-0">
                  <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
                    <button
                      type="button"
                      onClick={() => setSelected(allSelected ? new Set() : new Set(changes.map((c) => c.path)))}
                      className="press flex items-center gap-2 text-[12.5px] font-medium text-dim"
                    >
                      <Checkbox checked={allSelected} partial={!allSelected && selected.size > 0} />
                      {selected.size} of {changes.length} selected
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiffFor({ title: 'All changes' })}
                      className="press text-[12.5px] font-medium text-accent"
                    >
                      View all
                    </button>
                  </div>
                  <ul>
                    {changes.map((c) => (
                      <ChangeRow
                        key={c.path}
                        change={c}
                        checked={selected.has(c.path)}
                        onToggle={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.path)) next.delete(c.path);
                            else next.add(c.path);
                            return next;
                          })
                        }
                        onOpen={() => setDiffFor({ title: c.path, path: c.path })}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {changes !== null && changes.length > 0 && (
                <section className="glass flex flex-col gap-2.5 p-3.5">
                  <DictationHint dictation={dictation} />
                  <div className="composer flex items-start gap-1 rounded-2xl p-1">
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={3}
                      placeholder="Commit message"
                      className="min-h-[76px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[14.5px] leading-snug outline-none placeholder:text-dim/60"
                    />
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        aria-label="Write message with AI"
                        onClick={() => void suggest()}
                        className="press flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-accent/15"
                      >
                        {suggesting ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />}
                      </button>
                      <MicButton dictation={dictation} size={40} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!message.trim() || selected.size === 0 || busy !== null}
                      onClick={() => void commit(false)}
                      className="press tap flex items-center justify-center gap-2 rounded-2xl border border-line bg-surface-2 text-[14px] font-semibold disabled:opacity-40"
                    >
                      {busy === 'Commit' ? <Loader2 size={15} className="animate-spin" /> : <GitCommitHorizontal size={16} />}
                      Commit
                    </button>
                    <button
                      type="button"
                      disabled={!message.trim() || selected.size === 0 || busy !== null}
                      onClick={() => void commit(true)}
                      className="press tap btn-ok flex items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-white disabled:opacity-40"
                    >
                      {busy === 'Commit & push' ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
                      Commit & push
                    </button>
                  </div>
                  <p className="text-[11.5px] text-dim">
                    {allSelected ? 'Commits every change.' : `Commits ${selected.size} selected ${selected.size === 1 ? 'file' : 'files'}.`} ✨ writes the message
                    from the diff.
                  </p>
                </section>
              )}
            </>
          ) : (
            <section className="glass overflow-hidden p-0">
              {log === null ? (
                <div className="flex flex-col gap-2 p-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-11" />
                  ))}
                </div>
              ) : log.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-dim">No commits yet.</p>
              ) : (
                <ul>
                  {log.map((c, i) => (
                    <li key={c.hash}>
                      <button
                        type="button"
                        onClick={() => setDiffFor({ title: c.subject, hash: c.hash })}
                        className="press flex w-full items-start gap-3 px-3.5 py-2.5 text-left active:bg-white/[0.04]"
                      >
                        <span className="mt-1.5 flex flex-col items-center">
                          <span className={clsx('h-2.5 w-2.5 rounded-full', i < ahead ? 'bg-accent' : 'bg-line-strong')} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{c.subject}</span>
                          <span className="block truncate text-[11.5px] text-dim">
                            <span className="font-mono">{c.short}</span> · {c.author} · {relTime(c.ts)}
                            {i < ahead && <span className="text-accent"> · not pushed</span>}
                          </span>
                          {c.refs && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {c.refs
                                .split(',')
                                .map((r) => r.trim().replace(/^HEAD -> /, ''))
                                .filter(Boolean)
                                .slice(0, 3)
                                .map((r) => (
                                  <span key={r} className="rounded-md bg-accent-blue/12 px-1.5 py-[1px] font-mono text-[10.5px] text-accent-blue">
                                    {r}
                                  </span>
                                ))}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <CloneSection />
        </div>
      )}

      <DiffSheet
        projectId={projectId}
        target={diffFor}
        onClose={() => setDiffFor(null)}
        onDiscarded={() => {
          setDiffFor(null);
          void refresh();
        }}
      />
      <BranchSheet
        projectId={projectId}
        open={branchesOpen}
        current={status?.branch}
        onClose={() => setBranchesOpen(false)}
        onSwitched={() => {
          setBranchesOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function SyncButton({ icon, label, count, busy, onClick }: { icon: React.ReactNode; label: string; count?: number; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press relative flex h-11 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-2 text-[13px] font-semibold active:bg-surface-3"
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
      {label}
      {count ? <span className="badge absolute -right-1 -top-1.5 !bg-accent">{count}</span> : null}
    </button>
  );
}

function Checkbox({ checked, partial }: { checked: boolean; partial?: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
        checked || partial ? 'border-accent bg-accent text-white' : 'border-line-strong',
      )}
    >
      {checked ? <Check size={13} strokeWidth={3} /> : partial ? <span className="h-0.5 w-2.5 rounded bg-white" /> : null}
    </span>
  );
}

function ChangeRow({ change, checked, onToggle, onOpen }: { change: GitChange; checked: boolean; onToggle: () => void; onOpen: () => void }) {
  const badge = STATE_BADGE[change.state];
  const slash = change.path.lastIndexOf('/');
  const dir = slash >= 0 ? change.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? change.path.slice(slash + 1) : change.path;
  return (
    <li className="flex items-center border-b border-line last:border-b-0">
      <button type="button" aria-label={checked ? `Unselect ${change.path}` : `Select ${change.path}`} onClick={onToggle} className="flex h-12 w-12 shrink-0 items-center justify-center">
        <Checkbox checked={checked} />
      </button>
      <button type="button" onClick={onOpen} className="press flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pr-3.5 text-left active:bg-white/[0.04]">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{name}</span>
          {(dir || change.from) && (
            <span className="block truncate font-mono text-[11px] text-dim">{change.from ? `← ${change.from}` : dir}</span>
          )}
        </span>
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[11.5px] font-bold"
          style={{ color: badge.color, background: `${badge.color}1f` }}
          title={change.state}
        >
          {badge.letter}
        </span>
      </button>
    </li>
  );
}

function DiffSheet({
  projectId,
  target,
  onClose,
  onDiscarded,
}: {
  projectId: string;
  target: { title: string; path?: string; hash?: string } | null;
  onClose: () => void;
  onDiscarded: () => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setDiff(null);
    setConfirm(false);
    if (!target) return;
    const p = target.hash ? api.gitShow(projectId, target.hash) : api.gitDiff(projectId, target.path);
    p.then(setDiff).catch((err) => toast('error', errorMessage(err)));
  }, [target, projectId, toast]);

  const discard = async () => {
    if (!target?.path) return;
    try {
      await api.gitDiscard(projectId, target.path);
      haptic('warning');
      toast('info', `Discarded changes in ${target.path}`);
      onDiscarded();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  return (
    <Sheet open={target !== null} onClose={onClose} title={target?.title} subtitle={target?.hash ? `Commit ${target.hash.slice(0, 8)}` : 'Working tree vs HEAD'}>
      {diff === null ? <div className="skeleton h-40" /> : <DiffView diff={diff.diff} truncated={diff.truncated} />}
      {target?.path && diff && (
        <button
          type="button"
          onClick={() => (confirm ? void discard() : setConfirm(true))}
          className={clsx(
            'press tap mt-3 flex w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold',
            confirm ? 'bg-danger text-white' : 'border border-danger/30 bg-danger/10 text-danger',
          )}
        >
          <Undo2 size={15} /> {confirm ? 'Tap again — this cannot be undone' : 'Discard changes to this file'}
        </button>
      )}
    </Sheet>
  );
}

function BranchSheet({
  projectId,
  open,
  current,
  onClose,
  onSwitched,
}: {
  projectId: string;
  open: boolean;
  current?: string;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranches(null);
    api.gitBranches(projectId).then(setBranches).catch((err) => toast('error', errorMessage(err)));
  }, [open, projectId, toast]);

  const checkout = async (branch: string, create = false) => {
    setBusy(branch);
    try {
      const res = await api.gitCheckout(projectId, branch, create);
      toast(res.ok ? 'info' : 'warn', res.message);
      if (res.ok) {
        haptic('success');
        onSwitched();
      }
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const localNames = new Set(branches?.local ?? []);
  const remoteOnly = (branches?.remote ?? []).filter((r) => !localNames.has(r.replace(/^[^/]+\//, '')));

  return (
    <Sheet open={open} onClose={onClose} title="Branches" subtitle={current ? `On ${current}` : undefined}>
      <form
        className="composer mb-3 flex items-center gap-1 rounded-2xl p-1 pl-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) void checkout(newName.trim(), true);
        }}
      >
        <Plus size={16} className="shrink-0 text-dim" />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value.replace(/\s+/g, '-'))}
          placeholder="new-branch-name"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent px-1.5 py-2.5 font-mono text-[13.5px] outline-none placeholder:text-dim/60"
        />
        <button type="submit" disabled={!newName.trim()} className="press btn-primary h-10 rounded-xl px-3.5 text-[13px] font-semibold text-white disabled:opacity-35">
          Create
        </button>
      </form>
      {branches === null ? (
        <div className="skeleton h-32" />
      ) : (
        <div className="flex flex-col gap-1">
          {branches.local.map((b) => (
            <BranchRow key={b} name={b} current={b === branches.current} busy={busy === b} onClick={() => b !== branches.current && void checkout(b)} />
          ))}
          {remoteOnly.length > 0 && <h3 className="section-title mt-3 px-1 pb-1">Remote</h3>}
          {remoteOnly.map((b) => (
            <BranchRow key={b} name={b} remote busy={busy === b} onClick={() => void checkout(b)} />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function BranchRow({ name, current, remote, busy, onClick }: { name: string; current?: boolean; remote?: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'press tap flex w-full items-center gap-3 rounded-xl px-3 text-left',
        current ? 'bg-accent/12' : 'active:bg-white/[0.06]',
      )}
    >
      <GitBranch size={15} className={current ? 'text-accent' : 'text-dim'} />
      <span className={clsx('min-w-0 flex-1 truncate font-mono text-[13.5px]', remote && 'text-dim')}>{name}</span>
      {busy ? <Loader2 size={15} className="animate-spin" /> : current ? <Check size={16} className="text-accent" /> : null}
    </button>
  );
}

function CloneSection() {
  const cloneProject = useAppStore((s) => s.cloneProject);
  const openProject = useAppStore((s) => s.openProject);
  const toast = useAppStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);

  const clone = async (repo: GithubRepo) => {
    if (cloning) return;
    setCloning(repo.nameWithOwner);
    try {
      const created = await cloneProject({
        url: repo.url || `https://github.com/${repo.nameWithOwner}.git`,
        name: repo.nameWithOwner.split('/')[1],
      });
      toast('info', `Cloning ${repo.nameWithOwner}…`);
      setOpen(false);
      await openProject(created.id);
    } catch (err) {
      toast('error', `Clone failed: ${errorMessage(err)}`);
    } finally {
      setCloning(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="press glass-soft mt-1 flex w-full items-center gap-3 p-3 text-left active:bg-surface-3"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.07]">
          <Github size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold">Clone from GitHub</span>
          <span className="block text-[11.5px] text-dim">Your repos via the server's gh CLI</span>
        </span>
        {cloning && <Loader2 size={16} className="animate-spin text-accent" />}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Clone a repository">
        <RepoPicker onPick={(repo) => void clone(repo)} />
      </Sheet>
    </>
  );
}

