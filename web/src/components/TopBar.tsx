import { UsageCircleButton } from './UsageCircleButton';
import { ConnectionPill } from './ConnectionPill';
import { ServerSwitcher } from './SavedServers';
import { Search } from 'lucide-react';
import { openQuickOpen } from './QuickOpen';

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
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Search"
            title="Search terminals, projects, chats and files"
            onClick={openQuickOpen}
            className="press tap flex h-9 w-9 items-center justify-center rounded-xl text-dim active:bg-white/10"
          >
            <Search size={18} />
          </button>
          <ConnectionPill className="shrink-0" />
        </div>
      </div>
    </header>
  );
}
