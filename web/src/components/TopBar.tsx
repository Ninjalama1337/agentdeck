import { useAppStore } from '../store/appStore';
import { UsageCircleButton } from './UsageCircleButton';
import { ConnectionPill } from './ConnectionPill';

export function TopBar() {
  const keyboardOpen = useAppStore((s) => s.keyboardOpen);

  return (
    <header
      role="banner"
      className="safe-t sticky top-0 z-30 w-full shrink-0 border-b border-line transition-transform duration-200 motion-reduce:transition-none"
      style={{
        background: 'var(--ad-glass-strong)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        backdropFilter: 'blur(20px) saturate(130%)',
        transform: keyboardOpen ? 'translateY(-110%)' : undefined,
      }}
    >
      <div className="mx-auto flex h-[52px] w-full max-w-xl items-center justify-between px-3">
        <UsageCircleButton showLabel={true} />
        <ConnectionPill />
      </div>
    </header>
  );
}
