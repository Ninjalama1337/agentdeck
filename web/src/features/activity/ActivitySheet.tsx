import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentId, PlanSnapshot, RunRecord, RunSource, StatsBucket, StatsResponse } from '@agentdeck/shared';
import { AGENT_ACCENTS, AGENT_LABELS } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { relTime } from '../../util/format';
import {
  METRIC_LABELS,
  compact,
  dayKeys,
  dayLabel,
  duration,
  formatMetric,
  metricOf,
  money,
  niceDurationMax,
  niceMax,
  type Metric,
} from './activityMath';

const DAY_MS = 24 * 60 * 60_000;
const RANGES = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All', days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const METRICS: Metric[] = ['runs', 'tokens', 'cost', 'time'];
/** Launcher presets that are not chat agents. */
const EXTRA_LABELS: Record<string, string> = { gemini: 'Gemini CLI', aider: 'Aider', agy: 'Antigravity (AGY)' };
const SOURCE_LABELS: Record<RunSource, string> = {
  app: 'Chat',
  terminal: 'Terminal',
  routine: 'Routines',
  team: 'Team runs',
  mcp: 'Called by another agent',
};
const NEUTRAL = '#99A1B3';
/** One series, one color — the days are not split by agent, so no hue has to tell agents apart. */
const SERIES = '#7C5CFF';

function agentLabel(id: string): string {
  return AGENT_LABELS[id as AgentId] ?? EXTRA_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function agentAccent(id: string): string {
  return AGENT_ACCENTS[id as AgentId] ?? NEUTRAL;
}

function sumBuckets(buckets: StatsBucket[]): StatsBucket {
  const sum: StatsBucket = {
    runs: 0,
    ok: 0,
    errors: 0,
    stopped: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    toolCalls: 0,
  };
  for (const b of buckets) for (const key of Object.keys(sum) as (keyof StatsBucket)[]) sum[key] += b[key];
  return sum;
}

/**
 * Activity: what the agents did — runs, working time, tokens and cost per day,
 * agent, project and model, the subscriptions' limits over time and the single
 * runs. Read from the server's database.
 */
export function ActivitySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useAppStore((s) => s.toast);
  const [range, setRange] = useState<RangeId>('30d');
  const [metric, setMetric] = useState<Metric>('runs');
  const [agent, setAgent] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = RANGES.find((r) => r.id === range)?.days ?? 30;
      const to = Date.now() + 1;
      // Whole local days: the range starts at midnight, so its first column is complete.
      const start = new Date(to - (days - 1) * DAY_MS);
      start.setHours(0, 0, 0, 0);
      setStats(await api.stats({ from: days ? start.getTime() : 0, to }));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // An agent filter that no longer matches anything in the range falls back to all.
  const agents = stats?.byAgent ?? [];
  const selected = agent && agents.some((a) => a.agentId === agent) ? agent : null;
  const totals = useMemo(
    () => (stats ? (selected ? sumBuckets(stats.byAgent.filter((a) => a.agentId === selected)) : stats.totals) : null),
    [stats, selected],
  );

  return (
    <Sheet open={open} onClose={onClose} title="Activity" subtitle="What your agents did — runs, time, tokens and cost">
      <div className="mb-3 flex gap-1.5" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <Chip key={r.id} on={range === r.id} onClick={() => setRange(r.id)}>
            {r.label}
          </Chip>
        ))}
        {loading && stats && <Spinner size={14} className="ml-auto self-center text-dim" />}
      </div>

      {!stats ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !stats.available ? (
        <p className="rounded-xl border border-line bg-white/[0.04] p-3 text-[13px] leading-relaxed text-dim">
          {stats.reason ?? 'This server keeps no activity record.'}
        </p>
      ) : stats.firstRunAt === undefined ? (
        <p className="rounded-xl border border-line bg-white/[0.04] p-3 text-[13px] leading-relaxed text-dim">
          Nothing on record yet. Every chat turn, routine, team step and terminal turn from now on shows up here.
        </p>
      ) : (
        totals && (
          <>
            {agents.length > 1 && (
              <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1" role="group" aria-label="Agent">
                <Chip on={selected === null} onClick={() => setAgent(null)}>
                  All agents
                </Chip>
                {agents.map((a) => (
                  <Chip key={a.agentId} on={selected === a.agentId} onClick={() => setAgent(a.agentId)} dot={agentAccent(a.agentId)}>
                    {agentLabel(a.agentId)}
                  </Chip>
                ))}
              </div>
            )}

            <div className="mb-4 grid grid-cols-2 gap-2">
              <Tile label="Runs" value={compact(totals.runs)} note={runsNote(totals)} />
              <Tile label="Working time" value={duration(totals.durationMs)} note={`${compact(totals.toolCalls)} tool calls`} />
              <Tile
                label="Tokens"
                value={compact(metricOf(totals, 'tokens'))}
                note={`${compact(totals.outputTokens)} written · ${compact(totals.cacheReadTokens)} from cache`}
              />
              <Tile
                label="Cost"
                value={totals.costUsd > 0 ? money(totals.costUsd) : '–'}
                note={totals.costUsd > 0 ? 'at API prices, as the CLIs report it' : 'none reported in this range'}
              />
            </div>

            <DailyChart stats={stats} agent={selected} metric={metric} onMetric={setMetric} />

            {!selected && agents.length > 0 && (
              <Section title="By agent">
                <Breakdown
                  rows={agents.map((a) => ({ key: a.agentId, label: agentLabel(a.agentId), dot: agentAccent(a.agentId), bucket: a }))}
                  metric={metric}
                  onPick={(key) => setAgent(key)}
                />
              </Section>
            )}

            <Plans plans={stats.plans} history={stats.planHistory} agent={selected} />

            <Section title="By project" collapsed>
              <Breakdown
                rows={stats.byProject.map((p) => ({ key: p.projectId || '-', label: p.projectName || 'No project', bucket: p }))}
                metric={metric}
              />
              {selected && <Note>Projects count every agent.</Note>}
            </Section>

            <Section title="By model" collapsed>
              <Breakdown
                rows={stats.byModel
                  .filter((m) => !selected || m.agentId === selected)
                  .map((m) => ({
                    key: `${m.agentId}/${m.model}`,
                    label: m.model || `${agentLabel(m.agentId)} · default model`,
                    dot: agentAccent(m.agentId),
                    bucket: m,
                  }))}
                metric={metric}
              />
            </Section>

            {!selected && (
              <Section title="By origin" collapsed>
                <Breakdown
                  rows={stats.bySource.map((s) => ({ key: s.source, label: SOURCE_LABELS[s.source] ?? s.source, bucket: s }))}
                  metric={metric}
                />
              </Section>
            )}

            <Runs agent={selected} onClose={onClose} />

            <Note>
              On record since {new Date(stats.firstRunAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.
              Terminal turns carry tokens only for Claude Code; cost is what the same work would cost over the API, not what a
              subscription charges.
            </Note>
          </>
        )
      )}
    </Sheet>
  );
}

function runsNote(b: StatsBucket): string {
  if (b.runs === 0) return 'none in this range';
  const parts = [`${Math.round((b.ok / b.runs) * 100)}% finished`];
  if (b.errors) parts.push(`${b.errors} failed`);
  if (b.stopped) parts.push(`${b.stopped} stopped`);
  return parts.join(' · ');
}

function Chip({ on, onClick, dot, children }: { on: boolean; onClick: () => void; dot?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        'press tap flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium',
        on ? 'border-accent/60 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
      )}
    >
      {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden />}
      {children}
    </button>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.04] px-3 py-2.5">
      <p className="text-[11.5px] text-dim">{label}</p>
      <p className="mt-0.5 text-[22px] font-semibold leading-tight text-ink">{value}</p>
      {note && <p className="mt-0.5 text-[10.5px] leading-snug text-dim/80">{note}</p>}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-dim/80">{children}</p>;
}

function Section({ title, collapsed, children }: { title: string; collapsed?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="mt-5" aria-label={title}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press tap flex w-full items-center gap-1.5 py-1 text-left"
      >
        <h3 className="section-title">{title}</h3>
        <span className="ml-auto text-dim">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ daily */

function DailyChart({
  stats,
  agent,
  metric,
  onMetric,
}: {
  stats: StatsResponse;
  agent: string | null;
  metric: Metric;
  onMetric: (m: Metric) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const days = useMemo(() => {
    const from = stats.from > 0 ? stats.from : (stats.firstRunAt ?? stats.to);
    const keys = dayKeys(from, stats.to - 1);
    const byDay = new Map<string, StatsBucket[]>();
    for (const row of stats.byDay) {
      if (agent && row.agentId !== agent) continue;
      byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
    }
    return keys.map((key) => ({ key, bucket: sumBuckets(byDay.get(key) ?? []) }));
  }, [stats, agent]);

  const values = days.map((d) => metricOf(d.bucket, metric));
  const peak = Math.max(0, ...values);
  const top = metric === 'time' ? niceDurationMax(peak || 60_000) : niceMax(peak, metric !== 'cost');
  const shown = days.find((d) => d.key === picked) ?? null;
  const first = days[0];
  const last = days[days.length - 1];

  return (
    <section aria-label="Per day">
      <div className="flex items-center gap-1.5" role="group" aria-label="Measure">
        {METRICS.map((m) => (
          <Chip key={m} on={metric === m} onClick={() => onMetric(m)}>
            {METRIC_LABELS[m]}
          </Chip>
        ))}
      </div>
      {/* The readout names the day under the finger; without one it names the range. */}
      <p className="mt-2 h-5 text-[12.5px] text-dim" aria-live="polite">
        {shown ? (
          <>
            <span className="text-ink">{dayLabel(shown.key)}</span> · {formatMetric(metricOf(shown.bucket, metric), metric)}{' '}
            {metric === 'runs' ? (shown.bucket.runs === 1 ? 'run' : 'runs') : METRIC_LABELS[metric].toLowerCase()}
            {metric !== 'runs' && ` · ${shown.bucket.runs} ${shown.bucket.runs === 1 ? 'run' : 'runs'}`}
          </>
        ) : (
          `${METRIC_LABELS[metric]} per day — tap a column`
        )}
      </p>
      <div className="mt-1 flex gap-2">
        <div className="relative h-[120px] min-w-0 flex-1" onMouseLeave={() => setPicked(null)}>
          {[0, 0.5, 1].map((f) => (
            <div key={f} className="absolute inset-x-0 border-t border-white/[0.07]" style={{ bottom: `${f * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end">
            {days.map((d, i) => {
              const value = values[i] ?? 0;
              const on = picked === d.key;
              return (
                <button
                  key={d.key}
                  type="button"
                  // Not a toggle: a touch fires mouseenter first, and would undo its own pick.
                  onClick={() => setPicked(d.key)}
                  onMouseEnter={() => setPicked(d.key)}
                  onFocus={() => setPicked(d.key)}
                  aria-label={`${dayLabel(d.key)}: ${formatMetric(value, metric)}`}
                  className={clsx('flex h-full min-w-0 flex-1 items-end justify-center px-px', on && 'bg-white/[0.06]')}
                >
                  <span
                    className="block w-full max-w-[24px] rounded-t-[4px]"
                    style={{
                      height: value > 0 ? `max(2px, ${(value / top) * 100}%)` : 0,
                      background: SERIES,
                      opacity: picked && !on ? 0.45 : 1,
                    }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex h-[120px] w-9 shrink-0 flex-col justify-between text-right text-[10px] leading-none text-dim/80" aria-hidden>
          <span className="-translate-y-1">{formatMetric(top, metric)}</span>
          <span>{formatMetric(top / 2, metric)}</span>
          <span className="translate-y-1">0</span>
        </div>
      </div>
      <div className="mr-11 mt-1.5 flex justify-between text-[10px] text-dim/80" aria-hidden>
        <span>{first ? dayLabel(first.key, false) : ''}</span>
        <span>{last && last !== first ? dayLabel(last.key, false) : ''}</span>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- breakdown */

interface BreakdownRow {
  key: string;
  label: string;
  dot?: string;
  bucket: StatsBucket;
}

/** A table whose first number is drawn as a bar: each row names itself, the bar only compares. */
function Breakdown({ rows, metric, onPick }: { rows: BreakdownRow[]; metric: Metric; onPick?: (key: string) => void }) {
  if (rows.length === 0) return <Note>Nothing in this range.</Note>;
  const sorted = [...rows].sort((a, b) => metricOf(b.bucket, metric) - metricOf(a.bucket, metric));
  const peak = Math.max(...sorted.map((r) => metricOf(r.bucket, metric)), 0);
  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((row) => {
        const value = metricOf(row.bucket, metric);
        const body = (
          <>
            <div className="flex items-baseline gap-2">
              {row.dot && <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: row.dot }} aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{row.label}</span>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{formatMetric(value, metric)}</span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.07]" aria-hidden>
              <div
                className="h-full rounded-full"
                style={{ width: peak > 0 ? `${Math.max((value / peak) * 100, value > 0 ? 1.5 : 0)}%` : 0, background: row.dot ?? SERIES }}
              />
            </div>
            <p className="mt-1.5 text-[11px] tabular-nums text-dim">
              {row.bucket.runs} {row.bucket.runs === 1 ? 'run' : 'runs'} · {duration(row.bucket.durationMs)}
              {/* An agent that reports no tokens or cost has none on record — that is not zero. */}
              {metricOf(row.bucket, 'tokens') > 0 && ` · ${compact(metricOf(row.bucket, 'tokens'))} tokens`}
              {row.bucket.costUsd > 0 && ` · ${money(row.bucket.costUsd)}`}
              {row.bucket.errors > 0 && ` · ${row.bucket.errors} failed`}
            </p>
          </>
        );
        return (
          <li key={row.key}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(row.key)}
                className="press tap w-full rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
              >
                {body}
              </button>
            ) : (
              <div className="rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ plans */

function Plans({ plans, history, agent }: { plans: PlanSnapshot[]; history: PlanSnapshot[]; agent: string | null }) {
  const shown = plans.filter((p) => !agent || p.agentId === agent);
  if (shown.length === 0) return null;
  return (
    <Section title="Subscriptions">
      <ul className="flex flex-col gap-1.5">
        {shown.map((p) => {
          const points = history.filter((h) => h.agentId === p.agentId && h.weekPct !== undefined);
          return (
            <li key={p.agentId} className="rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: agentAccent(p.agentId) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{agentLabel(p.agentId)}</span>
                <span className="shrink-0 text-[12px] text-dim">{p.plan ?? 'Plan unknown'}</span>
              </div>
              {p.sessionPct !== undefined && <Meter label="Current session" pct={p.sessionPct} />}
              {p.weekPct !== undefined && <Meter label="This week" pct={p.weekPct} />}
              {points.length > 1 && <WeekTrend points={points} />}
              <p className="mt-1.5 text-[10.5px] text-dim/80">Read {relTime(p.ts)}</p>
            </li>
          );
        })}
      </ul>
      <Note>Limits are read whenever the app shows usage — the history fills in as you use it.</Note>
    </Section>
  );
}

/** Severity rides the fill; the figure and a word say the same, so it never rests on color. */
function Meter({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const level = clamped >= 90 ? 'danger' : clamped >= 70 ? 'warn' : 'ok';
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="text-dim">{label}</span>
        <span className="tabular-nums text-ink">
          {Math.round(clamped)}% used{level === 'danger' ? ' · nearly out' : level === 'warn' ? ' · high' : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-white/[0.07]" aria-hidden>
        <div
          className={clsx('h-full rounded-full', level === 'danger' ? 'bg-danger' : level === 'warn' ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${Math.max(clamped, clamped > 0 ? 1.5 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/** Weekly use over the range: a 2px line on a 0–100 % scale, peak named beside it. */
function WeekTrend({ points }: { points: PlanSnapshot[] }) {
  const w = 240;
  const h = 36;
  const t0 = points[0]?.ts ?? 0;
  const span = Math.max((points[points.length - 1]?.ts ?? 0) - t0, 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(((p.ts - t0) / span) * w).toFixed(1)},${(h - ((p.weekPct ?? 0) / 100) * h).toFixed(1)}`)
    .join(' ');
  const peak = Math.max(...points.map((p) => p.weekPct ?? 0));
  return (
    <div className="mt-2 flex items-center gap-2">
      <svg viewBox={`0 -2 ${w} ${h + 4}`} preserveAspectRatio="none" className="h-9 min-w-0 flex-1" role="img" aria-label={`Weekly use over the range, peak ${Math.round(peak)}%`}>
        <line x1="0" x2={w} y1={h} y2={h} stroke="rgba(255,255,255,0.1)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="shrink-0 text-[10.5px] tabular-nums text-dim">week · peak {Math.round(peak)}%</span>
    </div>
  );
}

/* ------------------------------------------------------------------- runs */

function Runs({ agent, onClose }: { agent: string | null; onClose: () => void }) {
  const toast = useAppStore((s) => s.toast);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [next, setNext] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      try {
        const page = await api.statsRuns({ limit: 20, ...(before ? { before } : {}), ...(agent ? { agentId: agent } : {}) });
        setRuns((old) => (before ? [...old, ...page.runs] : page.runs));
        setNext(page.next);
      } catch (err) {
        toast('error', errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [agent, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const open = (run: RunRecord) => {
    const st = useAppStore.getState();
    if (!run.sessionId) return;
    onClose();
    st.navigate({ name: 'chat' });
    void st.openSession(run.sessionId).catch(() => st.toast('warn', 'Session no longer exists'));
  };

  return (
    <Section title="Latest runs">
      {runs.length === 0 && !loading && <Note>Nothing on record.</Note>}
      <ul className="flex flex-col gap-1.5">
        {runs.map((run) => {
          const facts = [
            agentLabel(run.agentId),
            run.projectName,
            SOURCE_LABELS[run.source],
            duration(run.endedAt - run.startedAt),
            run.outputTokens !== undefined || run.inputTokens !== undefined
              ? `${compact((run.inputTokens ?? 0) + (run.outputTokens ?? 0) + (run.cacheWriteTokens ?? 0))} tokens`
              : undefined,
            run.costUsd !== undefined ? money(run.costUsd) : undefined,
          ].filter(Boolean);
          const body = (
            <>
              <div className="flex items-start gap-2">
                <RunMark status={run.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{run.title ?? run.summary ?? 'Terminal turn'}</span>
                <span className="shrink-0 text-[11px] text-dim">{relTime(run.startedAt)}</span>
              </div>
              <p className="mt-1 truncate pl-6 text-[11px] text-dim">{facts.join(' · ')}</p>
              {run.status !== 'ok' && run.error && <p className="mt-1 line-clamp-2 pl-6 text-[11px] text-dim">{run.error}</p>}
            </>
          );
          return (
            <li key={run.id}>
              {run.sessionId ? (
                <button type="button" onClick={() => open(run)} className="press tap w-full rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left">
                  {body}
                </button>
              ) : (
                <div className="rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {next !== undefined && (
        <Button size="sm" variant="ghost" full className="mt-2" loading={loading} onClick={() => void load(next)}>
          Show older
        </Button>
      )}
    </Section>
  );
}

/** Outcome as an icon with a name — never color alone. */
function RunMark({ status }: { status: RunRecord['status'] }) {
  if (status === 'ok') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok" role="img" aria-label="Finished">
        <Check size={10} />
      </span>
    );
  }
  if (status === 'stopped') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-dim" role="img" aria-label="Stopped">
        <Square size={8} />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger" role="img" aria-label="Failed">
      <AlertTriangle size={10} />
    </span>
  );
}
