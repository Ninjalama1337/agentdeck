import { useMemo } from 'react';
import { Search, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { Route } from '../store/appStore';
import { UsageCircleButton } from './UsageCircleButton';
import { openQuickOpen } from './QuickOpen';
import { ConnectionPill } from './ConnectionPill';
import { ServerSwitcher } from './SavedServers';
import { ProjectSwitcher } from './ProjectSwitcher';
import { InboxButton } from '../features/inbox/InboxSheet';
import { activeTabName, TABS, useTabIndicators } from './navigation';
import { isMacPlatform, shortcutLabel } from '../util/shortcuts';

/**
 * Desktop navigation (replaces TopBar + TabBar): project switcher, the tabs,
 * and below them what the top bar used to carry — plan usage, server,
 * connection — plus the notification inbox and Settings.
 */
export function Sidebar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const indicator = useTabIndicators();
  const mac = useMemo(isMacPlatform, []);
  const activeName = activeTabName(route);

  return (
    // No backdrop-filter here: it would make this the containing block of the sheets
    // opened from inside (project switcher, inbox) and trap them in the sidebar.
    <aside
      aria-label="AgentDeck"
      className="flex w-[236px] shrink-0 flex-col border-r border-line"
      style={{ background: 'var(--ad-glass-strong)' }}
    >
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[15px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)', boxShadow: '0 4px 14px rgba(124,92,255,0.35)' }}
        >
          A
        </span>
        <span className="text-[15px] font-bold tracking-tight">AgentDeck</span>
      </div>

      <div className="px-3 pb-2">
        <ProjectSwitcher sidebar />
      </div>

      <nav aria-label="Main navigation" className="flex flex-col gap-0.5 px-3 py-1">
        {TABS.map(({ route: tabRoute, label, icon }, i) => (
          <NavItem
            key={tabRoute.name}
            label={label}
            icon={icon}
            active={activeName === tabRoute.name}
            badge={indicator(tabRoute.name)}
            shortcut={shortcutLabel(String(i + 1), mac)}
            onClick={() => navigate(tabRoute)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="flex flex-col gap-2 border-t border-line p-3">
        <UsageCircleButton showLabel className="w-full" />
        <ServerSwitcher fill />
        <div className="flex items-center justify-between gap-2">
          <ConnectionPill className="shrink-0" />
          <InboxButton />
        </div>
        <NavItem label="Search" icon={Search} active={false} shortcut={shortcutLabel('P', mac)} onClick={openQuickOpen} />
        <NavItem
          label="Settings"
          icon={Settings}
          active={route.name === 'settings'}
          shortcut={shortcutLabel(',', mac)}
          onClick={() => navigate({ name: 'settings' } satisfies Route)}
        />
      </div>
    </aside>
  );
}

function NavItem({
  label,
  icon: Icon,
  active,
  badge,
  shortcut,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: React.ReactNode;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={clsx(
        'press group flex h-10 items-center gap-3 rounded-xl px-3 text-left text-[13.5px] font-medium transition-colors',
        active ? 'bg-accent/15 text-ink' : 'text-dim hover:bg-white/[0.06] hover:text-ink',
      )}
    >
      <Icon size={18} strokeWidth={active ? 2.2 : 1.8} className={clsx('shrink-0', active && 'text-accent')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
      <kbd className="shrink-0 font-sans text-[10.5px] font-normal text-dim/60 group-hover:text-dim">{shortcut}</kbd>
    </button>
  );
}
