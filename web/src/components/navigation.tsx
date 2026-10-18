import type { ReactNode } from 'react';
import { Folder, GitBranch, LayoutGrid, MessageSquare, SquareTerminal, Columns3 } from 'lucide-react';
import { isSessionUnread, useUnread } from '../store/unread';
import { useAppStore } from '../store/appStore';
import type { Route } from '../store/appStore';
import { TAB_ROUTES } from '../util/shortcuts';

const TAB_LOOK: Partial<Record<Route['name'], { label: string; icon: typeof MessageSquare }>> = {
  home: { label: 'Home', icon: LayoutGrid },
  chat: { label: 'Chats', icon: MessageSquare },
  agents: { label: 'Agents', icon: Columns3 },
  code: { label: 'Code', icon: SquareTerminal },
  git: { label: 'Git', icon: GitBranch },
  files: { label: 'Files', icon: Folder },
};

/** The main tabs — bottom bar on phones, sidebar on the desktop (same order as Ctrl/Cmd+1…5). */
export const TABS: { route: Route; label: string; icon: typeof MessageSquare }[] = TAB_ROUTES.map((route) => ({
  route,
  label: TAB_LOOK[route.name]?.label ?? route.name,
  icon: TAB_LOOK[route.name]?.icon ?? LayoutGrid,
}));

/** The tab a route belongs to (team runs live under Chats, Settings under Home). */
export function activeTabName(route: Route): Route['name'] {
  return route.name === 'team' ? 'chat' : route.name === 'settings' ? 'home' : route.name;
}

/** Live badge for a tab: running chats, terminals waiting for the user, uncommitted changes. */
export function useTabIndicators(): (name: Route['name']) => ReactNode {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const terminals = useAppStore((s) => s.terminals);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const drafts = useAppStore((s) => s.drafts);

  const unread = useUnread();
  const allSessions = Object.values(sessionsByProject).flat();
  const running = allSessions.filter((s) => s.status === 'running' || s.status === 'queued').length;
  const unreadChats = allSessions.filter((s) => isSessionUnread(s, unread)).length;
  // Runs that stopped to ask — the same signal as the board's "Needs you".
  const needsYou = allSessions.filter((s) => (drafts[s.id]?.permissions?.length ?? 0) > 0).length;
  const waiting = terminals.filter((t) => t.attention || unread.marked.includes(`terminal:${t.id}`)).length;
  const dirty = projects.find((p) => p.id === activeProjectId)?.git?.dirty ?? 0;

  return (name) => {
    if (name === 'agents' && needsYou > 0) return <span className="badge !bg-warn !text-black">{needsYou}</span>;
    if (name === 'agents' && running > 0) return <span className="block h-2.5 w-2.5 rounded-full bg-accent pulse-dot" />;
    if (name === 'chat' && unreadChats > 0) return <span className="badge">{unreadChats > 99 ? '99+' : unreadChats}</span>;
    if (name === 'chat' && running > 0) return <span className="block h-2.5 w-2.5 rounded-full bg-accent pulse-dot" />;
    if (name === 'code' && waiting > 0) return <span className="badge !bg-warn !text-black">{waiting}</span>;
    if (name === 'code' && terminals.length > 0) return <span className="block h-2 w-2 rounded-full bg-ok" />;
    if (name === 'git' && dirty > 0) return <span className="badge !bg-surface-3 !text-ink">{dirty > 99 ? '99+' : dirty}</span>;
    return null;
  };
}
