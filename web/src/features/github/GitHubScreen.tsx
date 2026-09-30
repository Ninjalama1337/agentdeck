import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Github as GithubIcon,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
} from 'lucide-react';
import type { GithubRepo, ProjectGitInfo } from '@agentdeck/shared';
import { api, ApiError } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { ProjectPicker } from '../../components/ProjectPicker';
import { RepoPicker } from './RepoPicker';
import { relTime } from '../../util/format';

export function GitHubScreen() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  if (!activeProjectId) {
    return (
      <div className="safe-t flex min-h-full flex-col px-4 pb-8">
        <header className="py-4">
          <h1 className="text-[20px] font-bold tracking-tight">GitHub</h1>
        </header>
        <div className="glass">
          <EmptyState
            icon={GithubIcon}
            title="No project selected"
            hint="Pick a project to see its git status, commit and push."
            action={
              <button
                type="button"
                onClick={() => useAppStore.getState().navigate({ name: 'home' })}
                className="press tap rounded-2xl px-5 text-[14px] font-semibold text-white"
                style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)' }}
              >
                Go to projects
              </button>
            }
          />
        </div>
      </div>
    );
  }
  return <GitHubScreenInner key={activeProjectId} projectId={activeProjectId} />;
}

function GitHubScreenInner({ projectId }: { projectId: string }) {
  const projects = useAppStore((s) => s.projects);
  const upsertProject = useAppStore((s) => s.upsertProject);
  const cloneProject = useAppStore((s) => s.cloneProject);
  const openProject = useAppStore((s) => s.openProject);
  const navigate = useAppStore((s) => s.navigate);
  const toast = useAppStore((s) => s.toast);

  const [git, setGit] = useState<ProjectGitInfo | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [loadingGit, setLoadingGit] = useState(true);
  const [commitMessage, setCommitMessage] = useState('');
  const [pushing, setPushing] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [showRepos, setShowRepos] = useState(false);

  const project = projects.find((p) => p.id === projectId);

  const refreshGit = useCallback(async () => {
    setLoadingGit(true);
    setGitError(null);
    try {
      const info = await api.gitStatus(projectId);
      setGit(info);
      if (project) upsertProject({ ...project, git: info });
    } catch (err) {
      setGitError(errorMessage(err));
    } finally {
      setLoadingGit(false);
    }
  }, [projectId, project, upsertProject]);

  useEffect(() => {
    void refreshGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const commitAndPush = async () => {
    if (!commitMessage.trim() || pushing) return;
    setPushing(true);
    try {
      const info = await api.gitCommit(projectId, { message: commitMessage.trim(), all: true });
      setGit(info);
      toast('info', 'Changes committed');
      try {
        const push = await api.gitPush(projectId);
        if (push.ok) toast('info', push.message || 'Pushed to remote');
        else toast('warn', push.message || 'Push failed');
      } catch (err) {
        toast('error', `Push failed: ${errorMessage(err)}`);
      }
      setCommitMessage('');
      void refreshGit();
    } catch (err) {
      toast('error', `Commit failed: ${errorMessage(err)}`);
    } finally {
      setPushing(false);
    }
  };

  const clone = async (repo: GithubRepo) => {
    if (cloning) return;
    setCloning(repo.nameWithOwner);
    try {
      const created = await cloneProject({
        url: repo.url || `https://github.com/${repo.nameWithOwner}.git`,
        name: repo.nameWithOwner.split('/')[1],
      });
      toast('info', `Cloning ${repo.nameWithOwner}…`);
      await openProject(created.id);
      navigate({ name: 'chat' });
    } catch (err) {
      toast('error', `Clone failed: ${errorMessage(err)}`);
    } finally {
      setCloning(null);
    }
  };

  const ghUnavailable = gitError !== null && /github/i.test(gitError);

  return (
    <div className="safe-t flex min-h-full flex-col px-4 pb-8">
      <header className="flex items-center justify-between py-4">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight">GitHub</h1>
          <p className="truncate text-[12.5px] text-dim">{project?.name ?? ''}</p>
        </div>
        <IconButton label="Refresh git status" onClick={() => void refreshGit()}>
          {loadingGit ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
        </IconButton>
      </header>

      <ProjectPicker className="mb-3" />

      {/* git status */}
      <section className="glass mb-4 p-4" aria-label="Git status">
        {gitError ? (
          <div className="flex items-start gap-2.5 text-[13px] leading-relaxed text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <p>
              {ghUnavailable
                ? 'Git status unavailable — the server reports a problem with git on this project.'
                : gitError}
            </p>
          </div>
        ) : loadingGit && git === null ? (
          <div className="skeleton h-8" />
        ) : git ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip dot="#4E8CFF">
              <GitBranch size={11} className="-ml-0.5" />
              {git.branch ?? 'no branch'}
            </Chip>
            {git.dirty !== undefined && (
              <Chip tone={git.dirty > 0 ? 'warn' : 'ok'}>
                {git.dirty} {git.dirty === 1 ? 'change' : 'changes'}
              </Chip>
            )}
            {git.ahead !== undefined && git.ahead > 0 && (
              <Chip tone="accent">
                <ArrowUp size={11} /> {git.ahead}
              </Chip>
            )}
            {git.behind !== undefined && git.behind > 0 && (
              <Chip tone="warn">
                <ArrowDown size={11} /> {git.behind}
              </Chip>
            )}
            {git.remote && <p className="mt-1.5 w-full truncate font-mono text-[11px] text-dim/80">{git.remote}</p>}
          </div>
        ) : (
          <p className="text-[13px] text-dim">Not a git repository.</p>
        )}
      </section>

      {/* commit + push */}
      <section className="glass mb-4 p-4" aria-label="Commit and push">
        <h2 className="mb-2.5 text-[14px] font-semibold">Commit &amp; push</h2>
        <textarea
          className="field min-h-[76px] text-[14px]"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message — stages all changes"
          rows={3}
        />
        <button
          type="button"
          disabled={!commitMessage.trim() || pushing}
          onClick={() => void commitAndPush()}
          className="press tap mt-3 flex w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg,#10B981,#0EA5E9)' }}
        >
          {pushing ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {pushing ? 'Working…' : 'Commit all & push'}
        </button>
        <p className="mt-2 text-[12px] text-dim">
          Stages every change, commits with your message and pushes to the current branch.
        </p>
      </section>

      {/* clone */}
      <section aria-label="Clone repositories">
        <button
          type="button"
          onClick={() => setShowRepos((v) => !v)}
          className="press tap glass flex w-full items-center gap-3 p-4 text-left active:bg-white/[0.09]"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.07] text-ink">
            <GithubIcon size={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-semibold">Clone a repository</span>
            <span className="block text-[12px] text-dim">Browse your GitHub repos via the server's gh CLI</span>
          </span>
          {cloning ? <Loader2 size={16} className="animate-spin text-accent" /> : null}
        </button>

        {showRepos && (
          <div className="mt-3">
            <RepoPicker onPick={(repo) => void clone(repo)} />
          </div>
        )}

        {gitError && ghUnavailable && (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3.5 text-[13px] leading-relaxed text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <p>
              GitHub features need the <span className="font-mono">gh</span> CLI installed and signed in
              on the AgentDeck server. Clone via URL still works from Projects → New project.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
