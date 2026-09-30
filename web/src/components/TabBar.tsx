import { Folder, LayoutGrid, MessageSquare, Settings, SquareTerminal } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';
import type { Route } from '../store/appStore';

const TABS: { route: Route; label: string; icon: typeof MessageSquare }[] = [
  { route: { name: 'chat' }, label: 'Threads', icon: MessageSquare },
  { route: { name: 'home' }, label: 'Home', icon: LayoutGrid },
  { route: { name: 'code' }, label: 'Code', icon: SquareTerminal },
  { route: { name: 'files' }, label: 'Files', icon: Folder },
  { route: { name: 'settings' }, label: 'Settings', icon: Settings },
];

export function TabBar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const keyboardOpen = useAppStore((s) => s.keyboardOpen);
  const overlayDepth = useAppStore((s) => s.overlayDepth);

  const activeName = route.name === 'team' ? 'chat' : route.name;
  // Any open sheet pushes the bar away, same slide-down treatment as the keyboard.
  const hidden = keyboardOpen || overlayDepth > 0;

  return (
    <nav
      aria-label="Main navigation"
      aria-hidden={hidden}
      className="safe-b fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch justify-around border-t border-line px-1 transition-transform duration-200 motion-reduce:transition-none"
      style={{
        background: 'var(--ad-glass-strong)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        backdropFilter: 'blur(20px) saturate(130%)',
        transform: hidden ? 'translateY(110%)' : undefined,
        pointerEvents: hidden ? 'none' : undefined,
      }}
    >
      {TABS.map(({ route: tabRoute, label, icon: Icon }) => {
        const active = activeName === tabRoute.name;
        return (
          <button
            key={tabRoute.name}
            type="button"
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(tabRoute)}
            className="tap press relative flex flex-1 flex-col items-center justify-center gap-0.5"
          >
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-2.5 top-1.5 bottom-1.5 rounded-2xl"
                style={{ background: 'rgba(124, 92, 255, 0.13)', boxShadow: 'inset 0 0 0 1px rgba(124, 92, 255, 0.28)' }}
              />
            )}
            <Icon
              size={21}
              className={clsx('relative transition-colors', active ? 'text-accent' : 'text-dim')}
              strokeWidth={active ? 2.2 : 1.8}
            />
            <span
              className={clsx(
                'relative text-[10px] font-medium tracking-wide',
                active ? 'text-ink' : 'text-dim',
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
