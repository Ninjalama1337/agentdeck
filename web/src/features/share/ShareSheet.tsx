import { useCallback, useMemo } from 'react';
import { FileText, Image as ImageIcon, MessageSquarePlus, Type } from 'lucide-react';
import type { Session } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { bytes, relTime } from '../../util/format';

const MAX_SESSIONS = 12;

/**
 * "Send to…" for something another app shared with AgentDeck: shows what
 * arrived and lets the user pick the chat. The chat's composer then takes the
 * text and uploads the files — nothing is sent before the user says so there.
 */
export function ShareSheet() {
  const share = useAppStore((s) => s.share);
  const dropShare = useAppStore((s) => s.dropShare);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const projects = useAppStore((s) => s.projects);
  const agents = useAppStore((s) => s.agents);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  // The active project's chats first, then the others — each newest first.
  const sessions = useMemo(() => {
    const byRecency = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
    const own = [...(activeProjectId ? (sessionsByProject[activeProjectId] ?? []) : [])].sort(byRecency);
    const others = Object.entries(sessionsByProject)
      .filter(([projectId]) => projectId !== activeProjectId)
      .flatMap(([, list]) => list)
      .sort(byRecency);
    return [...own, ...others].slice(0, MAX_SESSIONS);
  }, [sessionsByProject, activeProjectId]);

  const open = share !== null && share.target === null;
  // Dismissing discards the share — but the sheet also "closes" when the pick
  // navigates to the chat (a route change counts as back), and then it must stay.
  // Stable: the sheet re-registers with the back button whenever its close handler changes.
  const dismiss = useCallback(() => {
    if (useAppStore.getState().share?.target === null) dropShare();
  }, [dropShare]);
  if (!share) return null;

  const sendTo = (session: Session) => {
    const st = useAppStore.getState();
    st.aimShare(session.id);
    st.navigate({ name: 'chat' });
    void st.openSession(session.id).catch(() => {
      st.dropShare();
      st.toast('warn', 'Session no longer exists');
    });
  };

  const sendToNext = () => {
    const st = useAppStore.getState();
    st.aimShare('any');
    st.navigate({ name: 'chat' });
    st.toast('info', 'Open or start a chat — it lands in its message box');
  };

  const images = share.files.filter((f) => f.type.startsWith('image/')).length;
  const others = share.files.length - images;

  return (
    <Sheet open={open} onClose={dismiss} title="Send to a chat" subtitle="Shared with AgentDeck — nothing is sent until you send the message">
      <div className="mb-4 rounded-xl border border-line bg-white/[0.04] p-3">
        {share.text && (
          <div className="flex items-start gap-2">
            <Type size={14} className="mt-0.5 shrink-0 text-dim" aria-hidden />
            <p className="clamp-2 min-w-0 flex-1 break-words text-[13px] leading-snug text-ink/90">{share.text}</p>
          </div>
        )}
        {share.files.length > 0 && (
          <div className={share.text ? 'mt-2 flex items-start gap-2' : 'flex items-start gap-2'}>
            {images > 0 && others === 0 ? (
              <ImageIcon size={14} className="mt-0.5 shrink-0 text-dim" aria-hidden />
            ) : (
              <FileText size={14} className="mt-0.5 shrink-0 text-dim" aria-hidden />
            )}
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink/90">
              {share.files.length === 1
                ? `${share.files[0]?.name} · ${bytes(share.files[0]?.size)}`
                : `${share.files.length} files · ${bytes(share.files.reduce((sum, f) => sum + f.size, 0))}`}
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={sendToNext}
        className="press tap mb-2 flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <MessageSquarePlus size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold">Another or a new chat</span>
          <span className="block text-[12px] leading-snug text-dim">Goes to the next chat you open.</span>
        </span>
      </button>

      {sessions.length > 0 && <h3 className="section-title mb-1.5 mt-4">Recent chats</h3>}
      <ul className="flex flex-col gap-1.5">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => sendTo(session)}
              className="press tap flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
            >
              <AgentAvatar agent={agents[session.agentId]} agentId={session.agentId} size="sm" glow={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{session.title}</span>
                <span className="block truncate text-[11.5px] text-dim">
                  {projects.find((p) => p.id === session.projectId)?.name ?? 'project'} · {relTime(session.updatedAt)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
