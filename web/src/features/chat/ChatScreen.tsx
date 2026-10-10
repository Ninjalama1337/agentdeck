import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  MessageSquare,
  Monitor,
  MoreVertical,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { AgentInfo, Session } from '@agentdeck/shared';
import { selectSession, useAppStore } from '../../store/appStore';
import { AgentAvatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/Button';
import { MenuRow } from '../../components/ui/MenuRow';
import { Sheet } from '../../components/ui/Sheet';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { ModelBar } from './ModelBar';
import { ModeBar } from './ModeBar';
import { ModelSheet } from './ModelSheet';
import { NewSessionSheet } from './NewSessionSheet';
import { TeamComposer } from './TeamComposer';
import { UsageSheet } from '../settings/UsageSheet';
import { ChatSearch, messageMatches } from './ChatSearch';
import { SessionListPanel } from '../sessions/SessionListPanel';
import { EmptyState } from '../../components/ui/EmptyState';
import { useDesktopLayout } from '../../hooks/useDesktopLayout';

/** Phones: the session list, or the open conversation. Desktop: both side by side. */
export function ChatScreen() {
  const desktop = useDesktopLayout();
  return desktop ? <ChatSplit /> : <ChatPane />;
}

/** Desktop Chats: sessions on the left, the conversation of the selected one on the right. */
function ChatSplit() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  return (
    <div className="flex h-full">
      <aside aria-label="Sessions" className="w-[340px] shrink-0 overflow-y-auto overscroll-contain border-r border-line">
        <SessionListPanel embedded onNewSession={() => setNewSessionOpen(true)} onTeamRun={() => setTeamOpen(true)} />
      </aside>
      <section aria-label="Conversation" className="min-w-0 flex-1">
        <ChatPane embedded />
      </section>
      {activeProjectId && (
        <>
          <NewSessionSheet open={newSessionOpen} onClose={() => setNewSessionOpen(false)} projectId={activeProjectId} />
          <TeamComposer open={teamOpen} onClose={() => setTeamOpen(false)} projectId={activeProjectId} />
        </>
      )}
    </div>
  );
}

function ChatPane({ embedded = false }: { embedded?: boolean }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const loadedSessions = useAppStore((s) => s.loadedSessions);
  const session = useAppStore((s) => selectSession(s, s.activeSessionId));
  const agents = useAppStore((s) => s.agents);
  const projects = useAppStore((s) => s.projects);
  const messagesBySession = useAppStore((s) => s.messagesBySession);
  const openSession = useAppStore((s) => s.openSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const openInIde = useAppStore((s) => s.openInIde);
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);

  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const agent: AgentInfo | undefined = session ? agents[session.agentId] : undefined;
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined;

  /* auto-load the open session's history */
  useEffect(() => {
    if (!activeSessionId || loadedSessions[activeSessionId]) return;
    void openSession(activeSessionId).catch(() => {
      /* toast shown via notify/REST error paths */
    });
  }, [activeSessionId, loadedSessions, openSession]);

  /* plan usage for the header chip (kept fresh by useUsageTracking; this covers the first open) */
  useEffect(() => {
    if (!activeSessionId || !usage) void refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const sessionTokens = useMemo(() => {
    const msgs = activeSessionId ? messagesBySession[activeSessionId] : undefined;
    if (!msgs) return undefined;
    return msgs.reduce(
      (acc, m) => ({
        input: acc.input + (m.usage?.inputTokens ?? 0),
        output: acc.output + (m.usage?.outputTokens ?? 0),
      }),
      { input: 0, output: 0 },
    );
  }, [activeSessionId, messagesBySession]);

  const planRemainingPct = useMemo(() => {
    if (!usage || !session) return undefined;
    const own = usage.find((u) => u.agentId === session.agentId);
    const usedPct = own?.week?.pct ?? own?.rateLimits?.[0]?.window.pct;
    return typeof usedPct === 'number' ? Math.max(0, 100 - usedPct) : undefined;
  }, [usage, session]);

  const allMessages = activeSessionId ? messagesBySession[activeSessionId] : undefined;
  const shownMessages = useMemo(
    () => (searchOpen && query.trim() ? allMessages?.filter((m) => messageMatches(m, query)) : allMessages),
    [allMessages, searchOpen, query],
  );

  if (!session && embedded) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={MessageSquare} title="No conversation open" hint="Pick a session on the left, or start a new one." />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex flex-1 flex-col">
          <SessionListPanel onNewSession={() => setNewSessionOpen(true)} onTeamRun={() => setTeamOpen(true)} />
        </div>
        {activeProjectId && (
          <>
            <NewSessionSheet open={newSessionOpen} onClose={() => setNewSessionOpen(false)} projectId={activeProjectId} />
            <TeamComposer open={teamOpen} onClose={() => setTeamOpen(false)} projectId={activeProjectId} />
          </>
        )}
      </div>
    );
  }

  const running = session.status === 'running' || session.status === 'queued';
  const modeBar = <ModeBar session={session} agent={agent} />;
  const composer = <Composer key={`composer:${session.id}`} session={session} agent={agent} />;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header
        className="glass z-20 flex items-center gap-1.5 rounded-none border-x-0 border-t-0 px-2 py-1.5"
        style={{
          background: 'var(--ad-glass-strong)',
          WebkitBackdropFilter: 'blur(20px) saturate(130%)',
          backdropFilter: 'blur(20px) saturate(130%)',
        }}
      >
        {embedded ? (
          <span className="w-1.5 shrink-0" aria-hidden />
        ) : (
          <IconButton label="Back to sessions" onClick={closeSession}>
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <button type="button" className="flex min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-xl py-1 text-left">
          <AgentAvatar agent={agent} agentId={session.agentId} size="md" showDot glow={running} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[15px] font-semibold leading-tight">{agent?.label ?? session.agentId}</span>
              <StatusDot status={session.status} />
            </span>
            <span className="block truncate text-[11.5px] text-dim">
              {project?.name ?? session.projectId} · {session.title || 'Session'}
            </span>
          </span>
        </button>
        <IconButton label="Team run" onClick={() => setTeamOpen(true)} className="h-9 w-9">
          <Users size={17} />
        </IconButton>
        <IconButton label="Session menu" onClick={() => setMenuOpen(true)} className="h-9 w-9">
          <MoreVertical size={18} />
        </IconButton>
      </header>

      {/* model + thinking effort + live usage — always visible, one tap to change */}
      <ModelBar
        session={session}
        agent={agent}
        running={running}
        sessionTokens={sessionTokens}
        planRemainingPct={planRemainingPct}
        onOpen={() => setModelSheetOpen(true)}
        onOpenUsage={() => setUsageOpen(true)}
      />

      {searchOpen && (
        <ChatSearch
          query={query}
          onChange={setQuery}
          onClose={() => {
            setSearchOpen(false);
            setQuery('');
          }}
          count={shownMessages?.length ?? 0}
        />
      )}

      {/* messages */}
      <MessageList
        key={`messages:${session.id}`}
        sessionId={session.id}
        messages={shownMessages}
        agent={agent}
        loading={!loadedSessions[session.id]}
        running={running}
      />

      {/* composer — keyed: each session has its own unsent input */}
      {embedded ? (
        <div className="mx-auto w-full max-w-3xl">
          {modeBar}
          {composer}
        </div>
      ) : (
        <>
          {modeBar}
          {composer}
        </>
      )}

      {/* sheets */}
      <Sheet open={modelSheetOpen} onClose={() => setModelSheetOpen(false)} title="Model" subtitle={`${agent?.label ?? session.agentId} · applies from your next message`}>
        <ModelSheet open={modelSheetOpen} onClose={() => setModelSheetOpen(false)} session={session} agent={agent} />
      </Sheet>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Session">
        <div className="flex flex-col gap-1.5">
          <MenuRow
            icon={<Plus size={18} strokeWidth={1.8} />}
            label="New session"
            onClick={() => {
              setMenuOpen(false);
              setNewSessionOpen(true);
            }}
          />
          {running && (
            <MenuRow
              icon={<X size={18} strokeWidth={1.8} />}
              label="Interrupt run"
              danger
              onClick={() => {
                setMenuOpen(false);
                void useAppStore.getState().interrupt(session.id);
              }}
            />
          )}
          {agent?.capabilities.ideLaunch && (
            <MenuRow
              icon={<Monitor size={18} strokeWidth={1.8} />}
              label="Open project in IDE"
              onClick={() => {
                setMenuOpen(false);
                void openInIde(session.id);
              }}
            />
          )}
          <MenuRow
            icon={<Search size={18} strokeWidth={1.8} />}
            label="Search in chat"
            onClick={() => {
              setMenuOpen(false);
              setSearchOpen(true);
            }}
          />
          <MenuRow
            icon={<ExternalLink size={18} strokeWidth={1.8} />}
            label="Open files"
            onClick={() => {
              setMenuOpen(false);
              useAppStore.getState().navigate({ name: 'files' });
            }}
          />
          <div className="my-1.5 h-px bg-line" />
          <MenuRow
            icon={<Trash2 size={18} strokeWidth={1.8} />}
            label="Delete session"
            danger
            onClick={() => {
              setMenuOpen(false);
              void deleteSession(session.id);
            }}
          />
        </div>
      </Sheet>

      <NewSessionSheet open={newSessionOpen} onClose={() => setNewSessionOpen(false)} projectId={session.projectId} />
      <TeamComposer open={teamOpen} onClose={() => setTeamOpen(false)} projectId={session.projectId} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} />
    </div>
  );
}

function StatusDot({ status }: { status: Session['status'] }) {
  const color =
    status === 'running'
      ? '#7C5CFF'
      : status === 'queued'
        ? '#F59E0B'
        : status === 'error'
          ? '#F43F5E'
          : status === 'idle'
            ? '#10B981'
            : '#5b6478';
  return (
    <span
      aria-label={`Status: ${status}`}
      className={status === 'running' ? 'pulse-dot h-2 w-2 rounded-full' : 'h-2 w-2 rounded-full'}
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}
