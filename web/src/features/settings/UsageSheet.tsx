import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Loader2, RefreshCw, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentUsage, UsageWindow } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { normalizeMeridiemTimes } from '../../util/format';

/** "2m ago" style relative time for the fetch timestamp. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function Bar({ label, win, accent }: { label: string; win: UsageWindow; accent: string }) {
  const pct = win.pct ?? 0;
  const danger = pct >= 80;
  const fill = danger ? '#F43F5E' : accent;
  const resetAt = win.resetsAt ? Date.parse(win.resetsAt) : NaN;
  const resetLabel = win.resetsAt
    ? Number.isNaN(resetAt)
      ? normalizeMeridiemTimes(win.resetsAt)
      : new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(resetAt))
    : undefined;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-dim">
          <span className={danger ? 'font-semibold text-danger' : 'font-semibold text-ink'}>{pct}%</span>
          {resetLabel ? <span> · Reset: {resetLabel}</span> : null}
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
  onSwitchPlan,
  switchingPlan,
}: {
  usage: AgentUsage;
  accent: string;
  onSwitchPlan?: (agentId: string, planId: string) => Promise<void>;
  switchingPlan?: string | null;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const agentLabel = AGENT_LABELS[usage.agentId] ?? usage.agentId;

  if (!usage.available && !usage.plan) {
    return (
      <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[14px] font-semibold text-dim">{agentLabel}</span>
          <span className="rounded-full border border-line px-2 py-[1px] text-[10.5px] uppercase tracking-wide text-dim">
            n/a
          </span>
        </div>
        <p className="text-[12.5px] leading-relaxed text-dim">{usage.reason ?? 'No usage data.'}</p>
      </div>
    );
  }

  const stats = [
    usage.last24h
      ? {
          label: 'Last 24h',
          text: `${usage.last24h.requests ?? '?'} requests · ${usage.last24h.sessions ?? '?'} sessions`,
        }
      : null,
    usage.last7d
      ? {
          label: 'Last 7d',
          text: `${usage.last7d.requests ?? '?'} requests · ${usage.last7d.sessions ?? '?'} sessions`,
        }
      : null,
  ].filter((s): s is { label: string; text: string } => s !== null);

  return (
    <div className="rounded-2xl border border-line bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <AgentAvatar agent={undefined} agentId={usage.agentId} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-[14.5px] font-semibold">{agentLabel}</p>
            {usage.plan && <p className="truncate text-[11.5px] text-dim">{usage.plan}</p>}
          </div>
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
                            <span className="text-dim/80">({p.session.resetsAt})</span>
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
                            <span className="text-dim/80">({p.week.resetsAt})</span>
                          )}
                        </span>
                      )}
                      {p.tokens !== undefined && (
                        <span className="flex items-center gap-1 text-dim">
                          <span className="font-medium text-ink">Kontingent:</span>
                          <span className="text-ink">{(p.tokens / 1_000_000).toFixed(0)}M Tokens</span>
                          {p.resetsAt && (
                            <span className="text-dim/80">(bis {p.resetsAt})</span>
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

      <div className="flex flex-col gap-3">
        {usage.session && (
          <Bar
            label={usage.agentId === 'zcode' ? '5h-Limit (Sitzung)' : 'Session limit'}
            win={usage.session}
            accent={accent}
          />
        )}
        {usage.week && (
          <Bar
            label={
              usage.agentId === 'zcode'
                ? usage.activePlanId === 'free'
                  ? 'Gültigkeit (Free Tokens)'
                  : 'Wochenlimit (Abo)'
                : 'Weekly limit (all models)'
            }
            win={usage.week}
            accent={accent}
          />
        )}
        {usage.rateLimits?.map((limit) => (
          <Bar key={limit.name} label={limit.name} win={limit.window} accent={accent} />
        ))}
      </div>

      {usage.modelsQuota && usage.modelsQuota.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-line bg-black/20 p-3">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-dim">Model quotas</span>
          {usage.modelsQuota.map((model) => (
            <div key={model.name} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="font-medium text-ink">{model.name}</span>
              <span className="text-right text-dim">
                {model.sessionLimit ? `${model.sessionLimit.pct}% used` : ''}
                {model.weeklyLimit ? ` · Week: ${model.weeklyLimit.pct}% used` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {stats.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {stats.map((s) => (
            <span key={s.label} className="text-[12px] text-dim">
              <span className="font-medium text-ink">{s.label}:</span> {s.text}
            </span>
          ))}
        </div>
      )}

      {usage.reason && usage.plan && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-dim">{usage.reason}</p>
      )}

      {usage.raw && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setRawOpen((v) => !v)}
            className="press tap flex items-center gap-1 text-[12px] font-medium text-dim"
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

const ACCENTS: Record<string, string> = {
  claude: '#FF6A3D',
  zcode: '#7C5CFF',
  antigravity: '#4E8CFF',
  codex: '#10B981',
};

/** Subscription usage per agent (Claude, Antigravity, Codex, ZCode plans, ...). */
export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [switchingPlan, setSwitchingPlan] = useState<string | null>(null);

  useEffect(() => {
    if (open) void refreshUsage();
  }, [open, refreshUsage]);

  const refresh = async () => {
    setBusy(true);
    await refreshUsage();
    setBusy(false);
  };

  const handleSwitchPlan = async (agentId: string, planId: string) => {
    setSwitchingPlan(planId);
    try {
      await api.switchPlan(agentId, planId);
      toast('ok', `ZCode Plan gewechselt: ${planId === 'subscription' ? 'Abo-Modell' : 'Free Tokens'}`);
      await refreshUsage();
    } catch (err) {
      toast('error', `Fehler beim Planwechsel: ${(err as Error).message}`);
    } finally {
      setSwitchingPlan(null);
    }
  };

  const newest = usage?.reduce((acc, u) => Math.max(acc, u.fetchedAt ?? 0), 0);

  return (
    <Sheet open={open} onClose={onClose} title="Subscription usage" subtitle="Plan limits & activity of your agents">
      <div className="flex items-center justify-between px-1 pb-3">
        <span className="text-[12px] text-dim">
          {newest ? `updated ${ago(newest)} · cached 60s server-side` : ''}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || switchingPlan !== null}
          className="press tap flex items-center gap-1.5 rounded-full border border-line bg-white/[0.05] px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      {!usage ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-dim">
          <Loader2 size={15} className="animate-spin" />
          Reading usage from your agents…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {usage.map((u) => (
            <UsageCard
              key={u.agentId}
              usage={u}
              accent={ACCENTS[u.agentId] ?? '#7C5CFF'}
              onSwitchPlan={u.agentId === 'zcode' ? handleSwitchPlan : undefined}
              switchingPlan={switchingPlan}
            />
          ))}
          <p className="flex items-start gap-1.5 px-1 pb-1 text-[11.5px] leading-relaxed text-dim">
            <Gauge size={13} className="mt-0.5 shrink-0" />
            Claude limits come from the local Claude Code session. ZCode usage and tokens reflect your
            Z.AI account and local activity.
          </p>
        </div>
      )}
    </Sheet>
  );
}
