import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, GitCommitHorizontal, Sun } from 'lucide-react';
import type { DailySummary } from '@agentdeck/shared';
import { AGENT_ACCENTS, AGENT_SHORT_LABELS } from '@agentdeck/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';

const REFRESH_MS = 5 * 60_000;

function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * What the agents did today (the same summary the evening notification
 * sends): runs per agent, commits per project, cost and what was asked.
 * Older servers without /api/digest show nothing.
 */
export function TodayCard() {
  const [day, setDay] = useState<DailySummary | null>(null);
  const runEnded = useAppStore((s) => s.filesVersion);

  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .digestToday()
        .then((d) => live && setDay(d))
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [runEnded]);

  if (!day) return null;
  const commits = day.commits.reduce((n, c) => n + c.count, 0);
  const quiet = day.totals.runs === 0 && commits === 0;

  return (
    <section aria-label="Today" className="glass mb-5 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
        <Sun size={15} className="text-warn" /> Today
      </h2>
      {quiet ? (
        <p className="text-[12.5px] text-dim">Quiet so far — no agent runs or commits today.</p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat value={String(day.totals.runs)} label={day.totals.runs === 1 ? 'run' : 'runs'} />
            <Stat value={String(commits)} label={commits === 1 ? 'commit' : 'commits'} />
            <Stat
              value={day.totals.costUsd >= 0.01 ? `$${day.totals.costUsd.toFixed(2)}` : tokens(day.totals.inputTokens + day.totals.outputTokens)}
              label={day.totals.costUsd >= 0.01 ? 'API value' : 'tokens'}
            />
          </div>
          {day.byAgent.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {day.byAgent.map((a) => (
                <span key={a.agentId} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11.5px]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: AGENT_ACCENTS[a.agentId as keyof typeof AGENT_ACCENTS] ?? '#99A1B3' }} />
                  {AGENT_SHORT_LABELS[a.agentId as keyof typeof AGENT_SHORT_LABELS] ?? a.agentId} {a.runs}
                  {a.errors > 0 && <span className="text-danger">· {a.errors} failed</span>}
                </span>
              ))}
            </div>
          )}
          {day.commits.length > 0 && (
            <ul className="mb-2.5 flex flex-col gap-1">
              {day.commits.slice(0, 4).map((c) => (
                <li key={c.projectId} className="flex items-start gap-2 text-[12.5px]">
                  <GitCommitHorizontal size={14} className="mt-0.5 shrink-0 text-dim" />
                  <span className="min-w-0">
                    <span className="font-medium">{c.projectName}</span> <span className="text-dim">· {c.count}</span>
                    <span className="block truncate text-[11.5px] text-dim">{c.subjects[0]}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {day.highlights.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-line pt-2">
              {day.highlights.slice(0, 4).map((h, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px]">
                  {h.status === 'error' ? (
                    <CircleAlert size={13} className="mt-0.5 shrink-0 text-danger" />
                  ) : (
                    <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" />
                  )}
                  <span className="min-w-0 truncate">
                    {h.title}
                    {h.projectName && <span className="text-dim"> · {h.projectName}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] py-2">
      <span className="block text-[17px] font-bold tabular-nums">{value}</span>
      <span className="block text-[11px] text-dim">{label}</span>
    </div>
  );
}
