import { Folder, GitBranch, LayoutGrid, MessageSquare, SquareTerminal } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';
import type { Route } from '../store/appStore';
import { haptic } from '../util/haptics';

const TABS: { route: Route; label: string; icon: typeof MessageSquare }[] = [
  { route: { name: 'home' }, label: 'Home', icon: LayoutGrid },
  { route: { name: 'chat' }, label: 'Chats', icon: MessageSquare },
  { route: { name: 'code' }, label: 'Code', icon: SquareTerminal },
  { route: { name: 'git' }, label: 'Git', icon: GitBranch },
  { route: { name: 'files' }, label: 'Files', icon: Folder },
];

export function TabBar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const keyboardOpen = useAppStore((s) => s.keyboardOpen);
  const overlayDepth = useAppStore((s) => s.overlayDepth);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const terminals = useAppStore((s) => s.terminals);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  const activeName = route.name === 'team' ? 'chat' : route.name === 'settings' ? 'home' : route.name;
  // Any open sheet pushes the bar away, same slide-down treatment as the keyboard.
  const hidden = keyboardOpen || overlayDepth > 0;

  const running = Object.values(sessionsByProject)
    .flat()
    .filter((s) => s.status === 'running' || s.status === 'queued').length;
  const waiting = terminals.filter((t) => t.attention).length;
  const dirty = projects.find((p) => p.id === activeProjectId)?.git?.dirty ?? 0;

  const indicator = (name: Route['name']) => {
    if (name === 'chat' && running > 0) return <span className="block h-2.5 w-2.5 rounded-full bg-accent pulse-dot" />;
    if (name === 'code' && waiting > 0) return <span className="badge !bg-warn !text-black">{waiting}</span>;
    if (name === 'code' && terminals.length > 0) return <span className="block h-2 w-2 rounded-full bg-ok" />;
    if (name === 'git' && dirty > 0) return <span className="badge !bg-surface-3 !text-ink">{dirty > 99 ? '99+' : dirty}</span>;
    return null;
  };

  return (
    <nav
      aria-label="Main navigation"
      aria-hidden={hidden}
      className="safe-b fixed inset-x-0 bottom-0 z-30 border-t border-line transition-transform duration-200 motion-reduce:transition-none"
      style={{
        background: 'var(--ad-glass-strong)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        backdropFilter: 'blur(20px) saturate(130%)',
        transform: hidden ? 'translateY(110%)' : undefined,
        pointerEvents: hidden ? 'none' : undefined,
      }}
    >
      <div className="mx-auto flex h-16 max-w-xl items-stretch justify-around px-1">
        {TABS.map(({ route: tabRoute, label, icon: Icon }) => {
          const active = activeName === tabRoute.name;
          return (
            <button
              key={tabRoute.name}
              type="button"
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                if (!active) haptic();
                navigate(tabRoute);
              }}
              className="tap press relative flex flex-1 flex-col items-center justify-center gap-1"
            >
              <span
                className={clsx(
                  'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200',
                  active ? 'bg-accent/18' : '',
                )}
              >
                <Icon
                  size={20}
                  className={clsx('transition-colors', active ? 'text-accent' : 'text-dim')}
                  strokeWidth={active ? 2.3 : 1.8}
                />
                <span className="absolute left-[37px] -top-1">{indicator(tabRoute.name)}</span>
              </span>
              <span className={clsx('text-[10.5px] font-medium tracking-wide', active ? 'text-ink' : 'text-dim')}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
