import { useMemo } from 'react';
import type { AgentId, AgentUsage } from '@agentdeck/shared';
import { AGENT_ACCENTS, AGENT_SHORT_LABELS, AGENT_LABELS } from '@agentdeck/shared';
import { useAppStore } from '../store/appStore';

interface UsageCircleButtonProps {
  /** Optional agent override (e.g. within an active session). */
  agentId?: AgentId;
  className?: string;
  showLabel?: boolean;
}

export function UsageCircleButton({ agentId: propAgentId, className = '', showLabel = false }: UsageCircleButtonProps) {
  const currentUsageAgent = useAppStore((s) => s.currentUsageAgent);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const usageList = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const setUsageSheetOpen = useAppStore((s) => s.setUsageSheetOpen);

  // Determine active agent: prop override > active session's agent > store's currentUsageAgent
  const activeAgentId: AgentId = useMemo(() => {
    if (propAgentId) return propAgentId;
    if (activeSessionId) {
      for (const list of Object.values(sessionsByProject)) {
        const found = list.find((sess) => sess.id === activeSessionId);
        if (found) return found.agentId;
      }
    }
    return currentUsageAgent || 'claude';
  }, [propAgentId, activeSessionId, sessionsByProject, currentUsageAgent]);

  const agentUsage: AgentUsage | undefined = useMemo(() => {
    return usageList?.find((u) => u.agentId === activeAgentId);
  }, [usageList, activeAgentId]);

  const accent = AGENT_ACCENTS[activeAgentId] ?? '#7C5CFF';
  const shortLabel = AGENT_SHORT_LABELS[activeAgentId] ?? activeAgentId;
  const fullLabel = AGENT_LABELS[activeAgentId] ?? activeAgentId;

  // Percentage logic:
  // session % used is prioritized, then weekly % used.
  const pct = agentUsage?.session?.pct ?? agentUsage?.week?.pct ?? agentUsage?.rateLimits?.[0]?.window.pct;
  const isDanger = typeof pct === 'number' && pct >= 80;
  const isAvailable = agentUsage ? agentUsage.available : true;

  // Circle math (radius 13 in a 34x34 viewbox -> circumference ~81.68)
  const r = 13;
  const c = 2 * Math.PI * r; // ~81.68
  const clampedPct = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : (isAvailable ? 100 : 0);
  const strokeDashoffset = typeof pct === 'number' ? c - (c * clampedPct) / 100 : 0;
  const strokeColor = !isAvailable ? '#5B6478' : isDanger ? '#F43F5E' : accent;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!usageList) void refreshUsage();
    setUsageSheetOpen(true);
  };

  const displayText = useMemo(() => {
    if (typeof pct === 'number') return `${pct}%`;
    if (agentUsage?.cost) return agentUsage.cost;
    if (isAvailable) return 'OK';
    return '—';
  }, [pct, agentUsage, isAvailable]);

  const titleTooltip = `${fullLabel}: ${typeof pct === 'number' ? `${pct}% used` : agentUsage?.plan ?? 'Active'} · Tap to view all usages`;

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
        <div className="flex flex-col text-left pr-1.5">
          <span className="text-[11.5px] font-semibold text-ink leading-tight">{shortLabel}</span>
          <span className="text-[10px] text-dim leading-tight">
            {typeof pct === 'number' ? `${pct}% used` : agentUsage?.plan ? 'Active' : 'Usage'}
          </span>
        </div>
      )}
    </button>
  );
}
