import { useMemo } from 'react';
import type { AgentId, AgentUsage } from '@agentdeck/shared';
import { AGENT_ACCENTS, AGENT_SHORT_LABELS, AGENT_LABELS } from '@agentdeck/shared';
import { useAppStore } from '../store/appStore';
import { usePrefs } from '../store/prefs';
import { useNow } from '../hooks/useNow';
import { countdown, limitWindows, pctLabel, shownPct, USAGE_WARN_PCT } from '../util/usageWindows';

interface UsageCircleButtonProps {
  /** Optional agent override (e.g. within an active session). */
  agentId?: AgentId;
  className?: string;
  showLabel?: boolean;
}

export function UsageCircleButton({ agentId: propAgentId, className = '', showLabel = false }: UsageCircleButtonProps) {
  const currentUsageAgent = useAppStore((s) => s.currentUsageAgent);
  const usageList = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const setUsageSheetOpen = useAppStore((s) => s.setUsageSheetOpen);
  const display = usePrefs((s) => s.usageDisplay);
  const now = useNow();

  // Prop override, else the store's agent — kept on the agent in use by useUsageTracking.
  const activeAgentId: AgentId = propAgentId ?? currentUsageAgent ?? 'claude';

  const agentUsage: AgentUsage | undefined = useMemo(() => {
    return usageList?.find((u) => u.agentId === activeAgentId);
  }, [usageList, activeAgentId]);

  const accent = AGENT_ACCENTS[activeAgentId] ?? '#7C5CFF';
  const shortLabel = AGENT_SHORT_LABELS[activeAgentId] ?? activeAgentId;
  const fullLabel = AGENT_LABELS[activeAgentId] ?? activeAgentId;

  // Percentage logic:
  // session % used is prioritized, then weekly % used.
  const pct = agentUsage?.session?.pct ?? agentUsage?.week?.pct ?? agentUsage?.rateLimits?.[0]?.window.pct;
  const isDanger = typeof pct === 'number' && pct >= USAGE_WARN_PCT;
  // Side by side like Orca's status bar: the 5-hour and the weekly window.
  const windows = limitWindows(agentUsage).slice(0, 2);
  const nextReset = countdown(windows[0]?.resetsAt, now);
  const isAvailable = agentUsage ? agentUsage.available : true;

  // Circle math (radius 13 in a 34x34 viewbox -> circumference ~81.68)
  const r = 13;
  const c = 2 * Math.PI * r; // ~81.68
  // The ring follows the chosen reading; red still means "nearly used up".
  const clampedPct = typeof pct === 'number' ? shownPct(pct, display) : (isAvailable ? 100 : 0);
  const strokeDashoffset = typeof pct === 'number' ? c - (c * clampedPct) / 100 : 0;
  const strokeColor = !isAvailable ? '#5B6478' : isDanger ? '#F43F5E' : accent;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!usageList) void refreshUsage();
    setUsageSheetOpen(true);
  };

  const displayText = useMemo(() => {
    if (typeof pct === 'number') return `${shownPct(pct, display)}%`;
    if (agentUsage?.cost) return agentUsage.cost;
    if (isAvailable) return 'OK';
    return '—';
  }, [pct, agentUsage, isAvailable, display]);

  const titleTooltip = `${fullLabel}: ${
    windows.length
      ? windows.map((w) => `${w.short} ${pctLabel(w.pct, display)}${countdown(w.resetsAt, now) ? `, resets in ${countdown(w.resetsAt, now)}` : ''}`).join(' · ')
      : (agentUsage?.plan ?? 'Active')
  } · Tap to view all usages`;

  return (
    <button
      type="button"
      onClick={handleClick}
      title={titleTooltip}
      aria-label={titleTooltip}
      className={`press tap group relative inline-flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-1.5 backdrop-blur-md transition-all hover:border-white/[0.18] hover:bg-white/[0.08] active:scale-95 ${className}`}
      style={{
        boxShadow: `0 2px 12px ${accent}22`,
      }}
    >
      {/* Circular Progress Gauge */}
      <div className="relative flex h-[34px] w-[34px] shrink-0 items-center justify-center">
        <svg className="h-[34px] w-[34px] -rotate-90 transform" viewBox="0 0 34 34" aria-hidden="true">
          {/* Background circle track */}
          <circle
            cx="17"
            cy="17"
            r={r}
            className="stroke-white/[0.10]"
            strokeWidth="2.8"
            fill="none"
          />
          {/* Progress circle arc */}
          <circle
            cx="17"
            cy="17"
            r={r}
            stroke={strokeColor}
            strokeWidth="2.8"
            strokeDasharray={c}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="none"
            className="transition-all duration-700 ease-out"
            style={{
              filter: isAvailable ? `drop-shadow(0 0 4px ${strokeColor}88)` : undefined,
            }}
          />
        </svg>

        {/* Center content inside the circle */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-[9.5px] font-extrabold tabular-nums tracking-tighter text-ink"
            style={{ color: isDanger ? '#F43F5E' : undefined }}
          >
            {displayText}
          </span>
        </div>

        {/* Tiny agent indicator badge at bottom right */}
        <span
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-bg"
          style={{ background: accent }}
          aria-hidden="true"
        />
      </div>

      {showLabel && (
        <div className="flex min-w-0 flex-col gap-[3px] pr-1.5 text-left">
          <span className="truncate text-[11.5px] font-semibold leading-tight text-ink">
            {shortLabel}
            {nextReset && <span className="font-normal text-dim"> · {nextReset}</span>}
          </span>
          {windows.length ? (
            <span className="flex flex-col gap-[2px]">
              {windows.map((w) => (
                <span key={w.key} className="flex items-center gap-1.5">
                  <span className="h-[3px] w-10 overflow-hidden rounded-full bg-white/[0.1]">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${shownPct(w.pct, display)}%`, background: w.pct >= USAGE_WARN_PCT ? '#F43F5E' : accent }}
                    />
                  </span>
                  <span className="text-[9.5px] leading-none tabular-nums text-dim">
                    {shownPct(w.pct, display)}% {w.short}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-[10px] leading-tight text-dim">{agentUsage?.plan ? 'Active' : 'Usage'}</span>
          )}
        </div>
      )}
    </button>
  );
}
