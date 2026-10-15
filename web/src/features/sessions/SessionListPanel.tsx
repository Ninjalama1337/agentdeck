import { useState } from 'react';
import { ChevronRight, Clock, Loader2, MessageSquare, Plus, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { isSessionUnread, useUnread } from '../../store/unread';
import type { Session } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { AgentAvatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { relTime } from '../../util/format';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { InboxButton } from '../inbox/InboxSheet';

const STATUS_DOT: Record<Session['status'], string> = {
  idle: '#5b6478',
  queued: '#F59E0B',
  running: '#7C5CFF',
  error: '#F43F5E',
  stopped: '#5b6478',
};

/**
 * Shown on the Chat tab when no session is open: project sessions + team runs
 * + entry points to create both. `embedded` (desktop): the list is the left
 * column next to the conversation — the open session is marked, the inbox
 * button lives in the sidebar.
 */
export function SessionListPanel({
  onNewSession,
  onTeamRun,
  embedded = false,
}: {
  onNewSession: () => void;
  onTeamRun: () => void;
  embedded?: boolean;
}) {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const teamRuns = useAppStore((s) => s.teamRuns);
  const agents = useAppStore((s) => s.agents);
  const openSession = useAppStore((s) => s.openSession);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const unread = useUnread();
  const navigate = useAppStore((s) => s.navigate);

  const project = projects.find((p) => p.id === activeProjectId);
  const sessions = (activeProjectId ? (sessionsByProject[activeProjectId] ?? []) : []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const runs = teamRuns.filter((r) => r.projectId === activeProjectId).slice(0, 5);

  const open = async (session: Session) => {
    try {
      await openSession(session.id);
    } catch {
      /* handled by toast in store */
    }
  };

  if (!project) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No project selected"
        hint="Pick a project first — sessions live inside projects."
        action={
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className="press tap rounded-2xl px-5 text-[14px] font-semibold text-white btn-primary"
          >
            Go to projects
          </button>
        }
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col px-4 pb-8">
      <header className="flex items-center gap-1 py-2">
        <ProjectSwitcher className="min-w-0 flex-1" subtitle={`${sessions.length} ${sessions.length === 1 ? 'chat' : 'chats'}`} />
        {!embedded && <InboxButton />}
      </header>

      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={onNewSession}
          className="press tap flex flex-1 items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-white btn-primary"
        >
          <Plus size={16} /> New session
        </button>
        <button
          type="button"
          onClick={onTeamRun}
          className="press tap flex flex-1 items-center justify-center gap-2 rounded-2xl border border-line bg-surface-2 text-[14px] font-semibold active:bg-surface-3"
        >
          <Users size={16} /> Team run
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="glass mt-2">
          <EmptyState
            icon={MessageSquare}
            title="No sessions yet"
            hint="Start a session to drive an agent in this project."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sessions.map((session) => {
            const agent = agents[session.agentId];
            const active = session.status === 'running' || session.status === 'queued';
            const statusColor = STATUS_DOT[session.status];
            const selected = embedded && session.id === activeSessionId;
            const isUnread = isSessionUnread(session, unread);
            return (
              <button
                key={session.id}
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => void open(session)}
                title="Right-click or long-press: mark unread"
                onContextMenu={(e) => {
                  e.preventDefault();
                  const target = `session:${session.id}`;
                  if (isUnread) unread.view(target, Math.max(Date.now(), session.updatedAt));
                  else unread.mark(target);
                }}
                className={clsx(
                  'press tap glass flex items-center gap-3.5 p-3.5 text-left active:bg-surface-2 hover:bg-surface-2',
                  selected && '!border-accent/45 !bg-accent/10',
                )}
              >
                <AgentAvatar agent={agent} agentId={session.agentId} size="md" glow={active} />
                <span className="min-w-0 flex-1">
                  <span className={clsx('flex items-center gap-1.5 truncate text-[14.5px] leading-snug', isUnread ? 'font-bold text-ink' : 'font-semibold')}>
                    {isUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                    <span className="truncate">{session.title || 'Session'}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[12px] text-dim">
                    <span
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg-raise px-2 py-[2px]"
                    >
                      <span
                        className={clsx('h-1.5 w-1.5 rounded-full', active && 'pulse-dot')}
                        style={{ background: statusColor }}
                      />
                      {session.status}
                    </span>
                    {session.model && <span className="truncate font-mono text-[10.5px]">{session.model}</span>}
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
                      <Clock size={10} /> {relTime(session.updatedAt)}
                    </span>
                  </span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-dim" />
              </button>
            );
          })}
        </div>
      )}

      {runs.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-dim">Team runs</h2>
          <div className="flex flex-col gap-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => navigate({ name: 'team', runId: run.id })}
                className="press tap glass flex items-center gap-3 p-3 text-left active:bg-white/[0.09]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent">
                  <Users size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{run.title || 'Team run'}</span>
                  <span className="text-[12px] text-dim">
                    {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'} · {run.mode} · {run.status}
                  </span>
                </span>
                {run.status === 'running' && <Loader2 size={15} className="shrink-0 animate-spin text-accent" />}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
