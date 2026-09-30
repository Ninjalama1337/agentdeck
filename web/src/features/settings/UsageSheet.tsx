import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Loader2, RefreshCw } from 'lucide-react';
import type { AgentUsage, UsageWindow } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';

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
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-dim">
          <span className={danger ? 'font-semibold text-danger' : 'font-semibold text-ink'}>{pct}%</span>
          {win.resetsAt ? <span> · resets {win.resetsAt}</span> : null}
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

function UsageCard({ usage, accent }: { usage: AgentUsage; accent: string }) {
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

      <div className="flex flex-col gap-3">
        {usage.session && <Bar label="Session limit" win={usage.session} accent={accent} />}
        {usage.week && <Bar label="Weekly limit (all models)" win={usage.week} accent={accent} />}
      </div>

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
              {usage.raw}
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

/** Subscription usage per agent (Claude plan limits, codex login, ...). */
export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void refreshUsage();
  }, [open, refreshUsage]);

  const refresh = async () => {
    setBusy(true);
    await refreshUsage();
    setBusy(false);
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
          disabled={busy}
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
            <UsageCard key={u.agentId} usage={u} accent={ACCENTS[u.agentId] ?? '#7C5CFF'} />
          ))}
          <p className="flex items-start gap-1.5 px-1 pb-1 text-[11.5px] leading-relaxed text-dim">
            <Gauge size={13} className="mt-0.5 shrink-0" />
            Claude numbers come from the local Claude Code session (this machine only). IDE agents
            expose no usage API.
          </p>
        </div>
      )}
    </Sheet>
  );
}
