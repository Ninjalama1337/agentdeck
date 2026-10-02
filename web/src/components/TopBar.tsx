import { UsageCircleButton } from './UsageCircleButton';
import { ConnectionPill } from './ConnectionPill';
import { ServerSwitcher } from './SavedServers';

/**
 * Always-visible app bar (usage button + connection state). It is the first
 * row of the app shell, which follows the visible viewport — so it stays put
 * on every screen, soft keyboard open or not. Sits below <main> in z-order so
 * sheet backdrops dim it too.
 */
export function TopBar() {
  return (
    <header
      role="banner"
      className="safe-t relative z-[5] w-full shrink-0 border-b border-line"
      style={{
        background: 'var(--ad-glass-strong)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        backdropFilter: 'blur(20px) saturate(130%)',
      }}
    >
      <div className="mx-auto flex h-[52px] w-full max-w-xl items-center justify-between px-3">
        <UsageCircleButton showLabel={true} />
        <ServerSwitcher />
        <ConnectionPill className="shrink-0" />
      </div>
    </header>
  );
}
