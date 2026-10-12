import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';
import { haptic } from '../util/haptics';
import { activeTabName, TABS, useTabIndicators } from './navigation';

export function TabBar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const keyboardOpen = useAppStore((s) => s.keyboardOpen);
  const overlayDepth = useAppStore((s) => s.overlayDepth);

  const activeName = activeTabName(route);
  // Any open sheet pushes the bar away, same slide-down treatment as the keyboard.
  const hidden = keyboardOpen || overlayDepth > 0;
  const indicator = useTabIndicators();

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
