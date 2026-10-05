import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Coins, Gauge, Loader2, RefreshCw, Sparkles, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentId, AgentUsage, UsageWindow } from '@agentdeck/shared';
import { AGENT_ACCENTS, AGENT_LABELS, AGENT_SHORT_LABELS } from '@agentdeck/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { normalizeMeridiemTimes, resetLabel } from '../../util/format';

/** "2m ago" style relative time for the fetch timestamp. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function MiniCircleGauge({ pct, accent, cost, available }: { pct?: number; accent: string; cost?: string; available: boolean }) {
  const r = 14;
  const c = 2 * Math.PI * r; // ~87.96
  const isDanger = typeof pct === 'number' && pct >= 80;
  const clampedPct = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : (available ? 100 : 0);
  const strokeDashoffset = typeof pct === 'number' ? c - (c * clampedPct) / 100 : 0;
  const strokeColor = !available ? '#5B6478' : isDanger ? '#F43F5E' : accent;

  const display = typeof pct === 'number' ? `${pct}%` : cost ? cost : (available ? 'OK' : '—');

  return (
    <div className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center">
      <svg className="h-[38px] w-[38px] -rotate-90 transform" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r={r} className="stroke-white/[0.08]" strokeWidth="3" fill="none" />
        <circle
          cx="19"
          cy="19"
          r={r}
          stroke={strokeColor}
          strokeWidth="3"
          strokeDasharray={c}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="none"
          className="transition-all duration-700 ease-out"
          style={{ filter: available ? `drop-shadow(0 0 5px ${strokeColor}77)` : undefined }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          className="text-[10px] font-extrabold tabular-nums tracking-tighter text-ink"
          style={{ color: isDanger ? '#F43F5E' : undefined }}
        >
          {display}
        </span>
      </div>
    </div>
  );
}

function Bar({ label, win, accent }: { label: string; win: UsageWindow; accent: string }) {
  const pct = win.pct ?? 0;
  const danger = pct >= 80;
  const fill = danger ? '#F43F5E' : accent;
  const resetText = win.resetsAt ? resetLabel(win.resetsAt) : undefined;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-dim">
          <span className={danger ? 'font-semibold text-danger' : 'font-semibold text-ink'}>{pct}% used</span>
          {resetText ? <span> · resets {resetText}</span> : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={`${label}: ${pct}% used`}>
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, pct)}%`, background: fill, boxShadow: `0 0 10px ${fill}66` }}
        />
      </div>
    </div>
  );
}

function UsageCard({
  usage,
  accent,
  isActive,
  onSelectActive,
  onSwitchPlan,
  switchingPlan,
}: {
  usage: AgentUsage;
  accent: string;
  isActive: boolean;
  onSelectActive: () => void;
  onSwitchPlan?: (agentId: string, planId: string) => Promise<void>;
  switchingPlan?: string | null;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const agentLabel = AGENT_LABELS[usage.agentId] ?? usage.agentId;
  const shortLabel = AGENT_SHORT_LABELS[usage.agentId] ?? usage.agentId;
  const primaryPct = usage.session?.pct ?? usage.week?.pct ?? usage.rateLimits?.[0]?.window.pct;

  if (!usage.available && !usage.plan) {
    return (
      <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-dim">{agentLabel}</span>
            <span className="rounded-full border border-line px-2 py-[1px] text-[10.5px] uppercase tracking-wide text-dim">
              n/a
            </span>
          </div>
          <MiniCircleGauge available={false} accent={accent} />
        </div>
        <p className="text-[12.5px] leading-relaxed text-dim">{usage.reason ?? 'No usage data.'}</p>
      </div>
    );
  }

  const stats = [
    usage.last24h
      ? {
          label: 'Requests/Sessions (24h)',
          text: `${usage.last24h.requests ?? '?'} requests · ${usage.last24h.sessions ?? '?'} sessions`,
        }
      : null,
    usage.last7d
      ? {
          label: 'Requests/Sessions (7d)',
          text: `${usage.last7d.requests ?? '?'} requests · ${usage.last7d.sessions ?? '?'} sessions`,
        }
      : null,
  ].filter((s): s is { label: string; text: string } => s !== null);

  return (
    <div
      className={`relative rounded-2xl border p-4 transition-all ${
        isActive
          ? 'border-accent/40 bg-accent/[0.06] shadow-[0_0_20px_rgba(124,92,255,0.15)]'
          : 'border-line bg-white/[0.04]'
      }`}
    >
      {/* Header with Avatar, Label, MiniCircleGauge, and Active Pin Button */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <AgentAvatar agent={undefined} agentId={usage.agentId} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-[14.5px] font-semibold text-ink">{agentLabel}</p>
              {isActive && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/20 px-2 py-[2px] text-[10px] font-bold text-accent">
                  <Check size={10} strokeWidth={2.5} /> Active
                </span>
              )}
            </div>
            {usage.plan && <p className="truncate text-[11.5px] text-dim">{usage.plan}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onSelectActive}
            title={isActive ? 'Currently active in top-left button' : 'Show in top-left button'}
            className={`press tap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
              isActive
                ? 'border-accent/50 bg-accent/25 text-white'
                : 'border-line bg-white/[0.04] text-dim hover:text-ink hover:border-white/20'
            }`}
          >
            {isActive ? 'Selected' : 'Select'}
          </button>
          <MiniCircleGauge pct={primaryPct} cost={usage.cost} available={usage.available} accent={accent} />
        </div>
      </div>

      {/* Multi-plan switcher (ZCode subscription vs. free tokens) */}
      {usage.plans && usage.plans.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-line bg-black/20 p-3">
          <div className="flex items-center justify-between text-[12px] font-semibold text-ink">
            <span className="flex items-center gap-1.5">
              <Zap size={13} className="text-accent" />
              Tarife & Token
            </span>
            <span className="text-[11px] font-normal text-dim">Modus umschalten</span>
          </div>
          <div className="flex flex-col gap-2">
            {usage.plans.map((p) => {
              const isSwitching = switchingPlan === p.id;
              return (
                <div
                  key={p.id}
                  className={clsx(
                    'flex items-start justify-between gap-2 rounded-xl border p-2.5 transition-all',
                    p.active
                      ? 'border-accent/60 bg-accent/15 shadow-[0_0_14px_rgba(124,92,255,0.18)]'
                      : 'border-line/70 bg-white/[0.02]',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{p.label}</span>
                      {p.active && (
                        <span className="rounded-full bg-accent/25 px-2 py-[1px] text-[10.5px] font-semibold text-accent">
                          Aktiv
                        </span>
                      )}
                    </div>
                    {/* Quota & Reset indicators */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                      {p.session?.pct !== undefined && (
                        <span className="flex items-center gap-1 text-dim">
                          <span className="font-medium text-ink">5h:</span>
                          <span className={p.session.pct >= 80 ? 'font-semibold text-danger' : 'font-medium text-ink'}>
                            {p.session.pct}%
                          </span>
                          {p.session.resetsAt && (
                            <span className="text-dim/80">({resetLabel(p.session.resetsAt)})</span>
                          )}
                        </span>
                      )}
                      {p.week?.pct !== undefined && (
                        <span className="flex items-center gap-1 text-dim">
                          <span className="font-medium text-ink">Woche:</span>
                          <span className={p.week.pct >= 80 ? 'font-semibold text-danger' : 'font-medium text-ink'}>
                            {p.week.pct}%
                          </span>
                          {p.week.resetsAt && (
                            <span className="text-dim/80">({resetLabel(p.week.resetsAt)})</span>
                          )}
                        </span>
                      )}
                      {p.tokens !== undefined && (
                        <span className="flex items-center gap-1 text-dim">
                          <span className="font-medium text-ink">Kontingent:</span>
                          <span className="text-ink">{(p.tokens / 1_000_000).toFixed(0)}M Tokens</span>
                          {p.resetsAt && (
                            <span className="text-dim/80">(bis {resetLabel(p.resetsAt)})</span>
                          )}
                        </span>
                      )}
                    </div>
                    {p.detail && (
                      <p className="mt-1 text-[11px] text-dim/75">{p.detail}</p>
                    )}
                  </div>
                  {!p.active && onSwitchPlan && (
                    <button
                      type="button"
                      disabled={switchingPlan !== null && switchingPlan !== undefined}
                      onClick={() => void onSwitchPlan(usage.agentId, p.id)}
                      className="press tap mt-0.5 shrink-0 rounded-lg border border-accent/40 bg-accent/20 px-3 py-1.5 text-[11.5px] font-semibold text-accent hover:bg-accent/30 disabled:opacity-50"
                    >
                      {isSwitching ? (
                        <span className="flex items-center gap-1">
                          <Loader2 size={12} className="animate-spin" />
                          Wechsle…
                        </span>
                      ) : (
                        'Aktivieren'
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Progress Bars for Session & Weekly Limits */}
      <div className="flex flex-col gap-3">
        {usage.session && (usage.agentId === 'zcode' || typeof usage.session.pct === 'number') && (
          <Bar
            label={
              usage.agentId === 'antigravity'
                ? '5-Hour quota'
                : usage.agentId === 'zcode'
                  ? '5h-Limit (Sitzung)'
                  : 'Session limit'
            }
            win={usage.session}
            accent={accent}
          />
        )}
        {usage.week && (usage.agentId === 'zcode' || typeof usage.week.pct === 'number') && (
          <Bar
            label={
              usage.agentId === 'zcode'
                ? usage.activePlanId === 'free'
                  ? 'Gültigkeit (Free Tokens)'
                  : 'Wochenlimit (Abo)'
                : 'Weekly limit'
            }
            win={usage.week}
            accent={accent}
          />
        )}
        {usage.rateLimits?.map((limit) => (
          <Bar key={limit.name} label={limit.name} win={limit.window} accent={accent} />
        ))}
      </div>

      {/* Special Breakdown for Antigravity multi-model quota */}
      {usage.modelsQuota && usage.modelsQuota.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl bg-black/25 p-3 border border-white/[0.05]">
          <span className="text-[11.5px] font-semibold text-dim uppercase tracking-wider">Model Quotas</span>
          {usage.modelsQuota.map((m) => (
            <div key={m.name} className="flex items-center justify-between text-[12px]">
              <span className="text-ink font-medium">{m.name}</span>
              <span className="text-dim">
                {m.sessionLimit ? `${m.sessionLimit.pct}% used` : ''}
                {m.weeklyLimit ? ` · Week: ${m.weeklyLimit.pct}% used` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Special Breakdown for OpenCode tokens & cost */}
      {usage.tokens && (
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-black/25 p-2.5 border border-white/[0.05] text-center">
          <div>
            <span className="block text-[10.5px] text-dim">Input</span>
            <span className="text-[12.5px] font-semibold text-ink tabular-nums">{usage.tokens.input ?? '0'}</span>
          </div>
          <div>
            <span className="block text-[10.5px] text-dim">Output</span>
            <span className="text-[12.5px] font-semibold text-ink tabular-nums">{usage.tokens.output ?? '0'}</span>
          </div>
          <div>
            <span className="block text-[10.5px] text-dim">Cache Read</span>
            <span className="text-[12.5px] font-semibold text-ink tabular-nums">{usage.tokens.cache ?? '0'}</span>
          </div>
        </div>
      )}

      {/* Stats summary (requests, sessions) */}
      {stats.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {stats.map((s) => (
            <span key={s.label} className="text-[12px] text-dim">
              <span className="font-medium text-ink">{s.label}:</span> {s.text}
            </span>
          ))}
        </div>
      )}

      {/* Reason or status hint */}
      {usage.reason && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-dim">{usage.reason}</p>
      )}

      {/* Raw CLI output foldout */}
      {usage.raw && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setRawOpen((v) => !v)}
            className="press tap flex items-center gap-1 text-[12px] font-medium text-dim hover:text-ink"
          >
            {rawOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Raw CLI output
          </button>
          {rawOpen && (
            <pre className="no-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-dim">
              {normalizeMeridiemTimes(usage.raw)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Subscription usage per agent (Claude, Antigravity, OpenCode, Codex, ZCode). */
export function UsageSheet({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const storeUsageOpen = useAppStore((s) => s.usageSheetOpen);
  const setUsageSheetOpen = useAppStore((s) => s.setUsageSheetOpen);
  const currentUsageAgent = useAppStore((s) => s.currentUsageAgent);
  const setCurrentUsageAgent = useAppStore((s) => s.setCurrentUsageAgent);
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [switchingPlan, setSwitchingPlan] = useState<string | null>(null);

  const isOpen = open !== undefined ? open : storeUsageOpen;
  const handleClose = () => {
    if (onClose) onClose();
    setUsageSheetOpen(false);
  };

  useEffect(() => {
    if (isOpen) void refreshUsage();
  }, [isOpen, refreshUsage]);

  const refresh = async () => {
    setBusy(true);
    await refreshUsage();
    setBusy(false);
  };

  const handleSwitchPlan = async (agentId: string, planId: string) => {
    setSwitchingPlan(planId);
    try {
      await api.switchPlan(agentId, planId);
      toast('info', `ZCode Plan gewechselt: ${planId === 'subscription' ? 'Abo-Modell' : 'Free Tokens'}`);
      await refreshUsage();
    } catch (err) {
      toast('error', `Fehler beim Planwechsel: ${(err as Error).message}`);
    } finally {
      setSwitchingPlan(null);
    }
  };

  const newest = usage?.reduce((acc, u) => Math.max(acc, u.fetchedAt ?? 0), 0);

  // Preferred order: agy, opencode, claude, codex, zcode
  const PREFERRED_ORDER: AgentId[] = ['antigravity', 'opencode', 'claude', 'codex', 'zcode'];
  const sortedUsage = usage
    ? [...usage].sort((a, b) => {
        const idxA = PREFERRED_ORDER.indexOf(a.agentId);
        const idxB = PREFERRED_ORDER.indexOf(b.agentId);
        return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
      })
    : [];

  return (
    <Sheet open={isOpen} onClose={handleClose} title="Agent Usages" subtitle="Plan limits & quota of your coding tools">
      <div className="flex items-center justify-between px-1 pb-3">
        <span className="text-[12px] text-dim">
          {newest ? `updated ${ago(newest)} · cached 60s` : 'Reading live agent quotas…'}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || switchingPlan !== null}
          className="press tap flex items-center gap-1.5 rounded-full border border-line bg-white/[0.05] px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-50 hover:bg-white/[0.1]"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      {!usage ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-dim">
          <Loader2 size={15} className="animate-spin" />
          Reading usages from AGY, OpenCode, Claude, Codex & ZCode…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sortedUsage.map((u) => (
            <UsageCard
              key={u.agentId}
              usage={u}
              accent={AGENT_ACCENTS[u.agentId] ?? '#7C5CFF'}
              isActive={currentUsageAgent === u.agentId}
              onSelectActive={() => setCurrentUsageAgent(u.agentId)}
              onSwitchPlan={u.agentId === 'zcode' ? handleSwitchPlan : undefined}
              switchingPlan={switchingPlan}
            />
          ))}
          <p className="flex items-start gap-1.5 px-1 pb-1 text-[11.5px] leading-relaxed text-dim">
            <Gauge size={13} className="mt-0.5 shrink-0" />
            The button on the top left displays the currently active tool as a percentage circle.
            Tap "Select" on any tool above to feature it in the circle.
          </p>
        </div>
      )}
    </Sheet>
  );
}
