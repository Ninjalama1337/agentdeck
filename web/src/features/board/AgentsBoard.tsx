import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Clock, Columns3, Loader2, Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { Session } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { isSessionUnread, useUnread } from '../../store/unread';
import { AgentAvatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { relTime } from '../../util/format';
import {
  boardCounts,
  buildBoard,
  COLUMN_HINT,
  COLUMN_LABEL,
  COLUMN_ORDER,
  filterCards,
  type BoardCard,
} from './boardState';

/**
 * Agents board (after Orca's dashboard): every chat session of every project,
 * sorted by what it wants right now — Needs you / Working / Done / Idle — with
 * a search that doubles as history. Tap a card to jump into the chat.
 */
export function AgentsBoard() {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const drafts = useAppStore((s) => s.drafts);
  const projects = useAppStore((s) => s.projects);
  const openSession = useAppStore((s) => s.openSession);
  const fetchAllSessions = useAppStore((s) => s.fetchAllSessions);
  const navigate = useAppStore((s) => s.navigate);
  const unread = useUnread();
  const [query, setQuery] = useState('');

  useEffect(() => {
    void fetchAllSessions().catch(() => undefined);
  }, [fetchAllSessions]);

  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'Project';

  const board = useMemo(
    () =>
      buildBoard({
        sessions: Object.values(sessionsByProject).flat(),
        drafts,
        isUnread: (s) => isSessionUnread(s, unread),
      }),
    [sessionsByProject, drafts, unread],
  );
  const counts = boardCounts(board);
  const total = counts.needs + counts.working + counts.done + counts.idle;

  const haystack = (card: BoardCard): string =>
    `${card.session.title} ${AGENT_LABELS[card.session.agentId]} ${projectName(card.session.projectId)}`;

  const open = async (session: Session): Promise<void> => {
    try {
      await openSession(session.id);
      navigate({ name: 'chat' });
    } catch {
      /* the store toasts */
    }
  };

  if (total === 0) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          icon={Columns3}
          title="No agents yet"
          hint="Start a chat and it shows up here, sorted by what it wants from you."
          action={
            <button
              type="button"
              onClick={() => navigate({ name: 'chat' })}
              className="press tap rounded-2xl px-5 text-[14px] font-semibold text-white btn-primary"
            >
              Open chats
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col px-4 pb-8">
      <header className="py-2">
        <h1 className="text-[19px] font-bold tracking-tight">Agents</h1>
        <p className="text-[12.5px] text-dim">
          {total} {total === 1 ? 'session' : 'sessions'} across {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'}
        </p>
      </header>

      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dim" aria-hidden />
        <input
          className="field w-full pl-9 text-[13.5px]"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions, agents, projects…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search sessions"
        />
      </div>

      <div className="flex flex-col gap-4">
        {COLUMN_ORDER.map((column) => {
          const cards = filterCards(board[column], query, haystack);
          if (cards.length === 0 && query.trim()) return null;
          return (
            <section key={column}>
              <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
                <h2
                  className={clsx(
                    'text-[12px] font-semibold uppercase tracking-wider',
                    column === 'needs' ? 'text-warn' : 'text-dim',
                  )}
                >
                  {COLUMN_LABEL[column]}
                </h2>
                <span className="text-[11.5px] tabular-nums text-dim/70">{cards.length}</span>
                <span className="ml-auto truncate text-[11px] text-dim/70">{COLUMN_HINT[column]}</span>
              </div>
              {cards.length === 0 ? (
                <p className="rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-[12px] text-dim">Nothing here.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {cards.map((card) => (
                    <BoardCardRow
                      key={card.session.id}
                      card={card}
                      projectName={projectName(card.session.projectId)}
                      onOpen={() => void open(card.session)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCardRow({
  card,
  projectName,
  onOpen,
}: {
  card: BoardCard;
  projectName: string;
  onOpen: () => void;
}) {
  const { session } = card;
  const agent = useAppStore((s) => s.agents[session.agentId]);
  const active = session.status === 'running' || session.status === 'queued';
  const errorLine = session.status === 'error' ? session.lastError?.split('\n')[0] : undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx(
        'press tap glass flex items-center gap-3.5 p-3.5 text-left active:bg-surface-2',
        card.column === 'needs' && '!border-warn/45 !bg-warn/[0.06]',
      )}
    >
      <AgentAvatar agent={agent} agentId={session.agentId} size="md" glow={active} />
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            'flex items-center gap-1.5 truncate text-[14.5px] leading-snug',
            card.unread ? 'font-bold text-ink' : 'font-semibold',
          )}
        >
          {card.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
          <span className="truncate">{session.title || 'Session'}</span>
        </span>
        <span className="mt-1 flex items-center gap-2 text-[12px] text-dim">
          <span className="truncate">
            {AGENT_LABELS[session.agentId]} · {projectName}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
            <Clock size={10} /> {relTime(session.updatedAt)}
          </span>
        </span>
        {card.pending > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-[1px] text-[11px] font-semibold text-warn">
            <AlertTriangle size={10} /> {card.pending} waiting
          </span>
        )}
        {errorLine && <span className="mt-1 block truncate text-[11.5px] text-danger">{errorLine}</span>}
      </span>
      {active ? (
        <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
      ) : (
        <ChevronRight size={16} className="shrink-0 text-dim" />
      )}
    </button>
  );
}
