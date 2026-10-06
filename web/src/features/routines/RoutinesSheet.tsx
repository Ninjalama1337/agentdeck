import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Loader2, Play, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import type { AgentId, Routine, RoutineSchedule, RunRecord } from '@agentdeck/shared';
import { api, getApiBase } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { RunMark } from '../activity/ActivitySheet';
import { compact, duration, money } from '../activity/activityMath';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { relTime } from '../../util/format';

export function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === 'interval') {
    const m = schedule.minutes;
    if (m < 60) return `every ${m} min`;
    if (m % 1440 === 0) return `every ${m / 1440} ${m === 1440 ? 'day' : 'days'}`;
    return `every ${Math.round((m / 60) * 10) / 10} h`;
  }
  if (schedule.kind === 'daily') return `daily ${schedule.time}`;
  if (schedule.kind === 'commit') return 'on every new commit';
  if (schedule.kind === 'ci-failed') return 'when CI fails';
  if (schedule.kind === 'webhook') return 'when its webhook is called';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[schedule.weekday] ?? '?'} ${schedule.time}`;
}

/**
 * Routines (BridgeMind "agents on routines"): create / edit / enable / fire /
 * delete. Shown from the dashboard.
 */
export function RoutinesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const routines = useAppStore((s) => s.routines);
  const agents = useAppStore((s) => s.agents);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const createRoutine = useAppStore((s) => s.createRoutine);
  const updateRoutine = useAppStore((s) => s.updateRoutine);
  const deleteRoutine = useAppStore((s) => s.deleteRoutine);
  const fireRoutine = useAppStore((s) => s.fireRoutine);
  const toast = useAppStore((s) => s.toast);

  const list = useMemo(
    () => Object.values(routines).sort((a, b) => b.createdAt - a.createdAt),
    [routines],
  );

  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  const fire = async (id: string) => {
    setBusyId(id);
    try {
      const result = await fireRoutine(id);
      if (result.status === 'skipped') toast('info', 'Previous run still active — skipped.');
      else if (!result.ok) toast('error', 'Routine run failed — open the thread for details.');
      else onClose();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to run routine');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Routines" subtitle="Agents on recurring jobs">
      {editing !== null ? (
        <RoutineEditor
          routine={editing === 'new' ? null : editing}
          agents={agents}
          projects={projects}
          defaultProjectId={activeProjectId}
          onCancel={() => setEditing(null)}
          onSave={async (req) => {
            if (editing === 'new') await createRoutine(req);
            else await updateRoutine(editing.id, req);
            setEditing(null);
          }}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="press tap flex items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-white btn-primary"
          >
            <Repeat size={16} /> New routine
          </button>

          {list.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] leading-relaxed text-dim">
              No routines yet. Put a recurring job on an agent — e.g. “check the build every morning”.
            </p>
          ) : (
            list.map((routine) => {
              const agent = agents[routine.agentId];
              const project = projects.find((p) => p.id === routine.projectId);
              return (
                <div key={routine.id} className="rounded-2xl border border-line bg-surface p-3.5">
                  <div className="flex items-center gap-3">
                    <AgentAvatar agent={agent} agentId={routine.agentId} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold">{routine.name}</p>
                      <p className="truncate text-[11.5px] text-dim">
                        {agent?.label ?? routine.agentId} · {project?.name ?? routine.projectId}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={routine.enabled}
                      aria-label={routine.enabled ? 'Pause routine' : 'Resume routine'}
                      onClick={() => void updateRoutine(routine.id, { enabled: !routine.enabled }).catch(() => undefined)}
                      className="press flex h-8 w-13 shrink-0 items-center rounded-full border border-line p-[3px] transition-colors"
                      style={{ background: routine.enabled ? 'rgba(124,92,255,0.25)' : 'var(--ad-surface-2)' }}
                    >
                      <span
                        className="h-6 w-6 rounded-full transition-transform"
                        style={{
                          background: routine.enabled ? '#7C5CFF' : '#5b6478',
                          transform: routine.enabled ? 'translateX(22px)' : 'translateX(0)',
                        }}
                      />
                    </button>
                  </div>

                  <p className="clamp-2 mt-2 text-[12.5px] leading-relaxed text-dim">{routine.prompt}</p>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-dim">
                    <span className="font-medium text-ink/85">{scheduleLabel(routine.schedule)}</span>
                    {routine.enabled && routine.nextRunAt && (
                      <span>next {relTime(routine.nextRunAt)}</span>
                    )}
                    {routine.lastRunAt && <span>last {relTime(routine.lastRunAt)}</span>}
                    {routine.lastStatus === 'error' && <span className="text-danger">last run failed</span>}
                    {routine.freshContext && <span>fresh context each run</span>}
                  </div>

                  {routine.schedule.kind === 'webhook' && routine.hookToken && <HookUrl routine={routine} />}

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === routine.id}
                      onClick={() => void fire(routine.id)}
                      className="press tap flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-3 text-[12.5px] font-semibold active:bg-surface-3 disabled:opacity-50"
                    >
                      {busyId === routine.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      Run now
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(routine)}
                      className="press tap flex h-9 items-center rounded-xl border border-line bg-surface-2 px-3 text-[12.5px] font-semibold text-dim active:bg-surface-3"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete routine ${routine.name}`}
                      onClick={() => void deleteRoutine(routine.id).catch(() => undefined)}
                      className="press tap ml-auto flex h-9 w-9 items-center justify-center rounded-xl text-danger active:bg-danger/10"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  <RoutineHistory routine={routine} onOpen={onClose} />
                </div>
              );
            })
          )}
        </div>
      )}
    </Sheet>
  );
}

/* ----------------------------------------------------------------- history */

/** The routine's past runs (from the server's activity record), loaded when opened. */
function RoutineHistory({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  const toast = useAppStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);

  const load = async (before?: number) => {
    setLoading(true);
    try {
      const page = await api.routineRuns(routine.id, { limit: 10, ...(before ? { before } : {}) });
      setRuns((old) => (before && old ? [...old, ...page.runs] : page.runs));
      setNext(page.next);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Reloads when a run ended while the list is open.
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routine.lastRunAt]);

  const openSession = (run: RunRecord) => {
    const st = useAppStore.getState();
    if (!run.sessionId) return;
    onOpen();
    st.navigate({ name: 'chat' });
    void st.openSession(run.sessionId).catch(() => st.toast('warn', 'Session no longer exists'));
  };

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press tap flex w-full items-center gap-1 py-1 text-left text-[12px] font-medium text-dim"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        History
        {loading && <Loader2 size={12} className="ml-1 animate-spin" />}
      </button>
      {open && runs && (
        <>
          {runs.length === 0 && <p className="py-1 text-[12px] text-dim">No runs on record yet.</p>}
          <ul className="flex flex-col">
            {runs.map((run) => {
              const used = (run.inputTokens ?? 0) + (run.outputTokens ?? 0) + (run.cacheWriteTokens ?? 0);
              const facts = [
                duration(run.endedAt - run.startedAt),
                used > 0 ? `${compact(used)} tokens` : undefined,
                run.costUsd !== undefined ? money(run.costUsd) : undefined,
              ].filter(Boolean);
              return (
                <li key={run.id}>
                  <button type="button" onClick={() => openSession(run)} className="press tap w-full rounded-lg py-1.5 text-left">
                    <span className="flex items-start gap-2">
                      <RunMark status={run.status} />
                      <span className="min-w-0 flex-1 text-[12px] text-ink/90">
                        {relTime(run.startedAt)} <span className="text-dim">· {facts.join(' · ')}</span>
                      </span>
                    </span>
                    {(run.status === 'ok' ? run.summary : (run.error ?? run.summary)) && (
                      <span className="clamp-2 mt-0.5 block pl-6 text-[11.5px] leading-snug text-dim">
                        {run.status === 'ok' ? run.summary : (run.error ?? run.summary)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {next !== undefined && (
            <button type="button" disabled={loading} onClick={() => void load(next)} className="press tap w-full py-1.5 text-center text-[12px] text-dim">
              Show older
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The address a `webhook` routine is fired with — to copy into CI, a cron job, another service. */
function HookUrl({ routine }: { routine: Routine }) {
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const base = getApiBase() || window.location.origin;
  const url = `${base}/api/hooks/routine/${routine.id}/${routine.hookToken ?? ''}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('info', 'Webhook URL copied');
    } catch {
      toast('warn', 'Could not copy — select the address instead.');
    }
  };
  const renew = async () => {
    setBusy(true);
    try {
      // The routine:update broadcast brings the new token into the list.
      await api.renewRoutineHook(routine.id);
      toast('info', 'New webhook URL — the old one no longer works.');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2.5 rounded-xl border border-line bg-black/25 p-2.5">
      <p className="text-[11px] text-dim">
        Fires on <span className="font-mono">POST</span> to this address; a request body reaches the agent with the prompt.
      </p>
      <p className="mt-1 select-all break-all font-mono text-[11px] leading-snug text-ink/90">{url}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void copy()} className="press tap flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-[12px] font-medium">
          <Copy size={12} /> Copy
        </button>
        <button type="button" disabled={busy} onClick={() => void renew()} className="press tap flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-dim disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} New address
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

const WHEN: { kind: RoutineSchedule['kind']; label: string }[] = [
  { kind: 'interval', label: 'Interval' },
  { kind: 'daily', label: 'Daily' },
  { kind: 'weekly', label: 'Weekly' },
  { kind: 'commit', label: 'New commit' },
  { kind: 'ci-failed', label: 'CI failed' },
  { kind: 'webhook', label: 'Webhook' },
];

const EVENT_HINTS: Partial<Record<RoutineSchedule['kind'], string>> = {
  commit: 'Runs when the project’s checked-out branch gets a new commit — yours, an agent’s or a pull. The commit is named in the prompt.',
  'ci-failed': 'Runs when the newest finished GitHub Actions run of the project failed (checked every two minutes via gh). The run is linked in the prompt.',
  webhook: 'Runs when its address is called. You get the address after saving.',
};

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function RoutineEditor({
  routine,
  agents,
  projects,
  defaultProjectId,
  onCancel,
  onSave,
}: {
  routine: Routine | null;
  agents: Partial<Record<AgentId, import('@agentdeck/shared').AgentInfo>>;
  projects: import('@agentdeck/shared').Project[];
  defaultProjectId: string | null;
  onCancel: () => void;
  onSave: (req: import('@agentdeck/shared').CreateRoutineRequest) => Promise<void>;
}) {
  const [name, setName] = useState(routine?.name ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [projectId, setProjectId] = useState(routine?.projectId ?? defaultProjectId ?? projects[0]?.id ?? '');
  const [agentId, setAgentId] = useState<AgentId>(routine?.agentId ?? 'claude');
  const [kind, setKind] = useState<RoutineSchedule['kind']>(routine?.schedule.kind ?? 'interval');
  const [minutes, setMinutes] = useState(
    routine?.schedule.kind === 'interval' ? String(routine.schedule.minutes) : '60',
  );
  const [time, setTime] = useState(
    routine?.schedule.kind === 'daily' || routine?.schedule.kind === 'weekly' ? routine.schedule.time : '09:00',
  );
  const [freshContext, setFreshContext] = useState(routine?.freshContext === true);
  const [weekday, setWeekday] = useState<Weekday>(
    routine?.schedule.kind === 'weekly' ? ((routine.schedule.weekday as Weekday) ?? 1) : 1,
  );
  const [saving, setSaving] = useState(false);
  const toast = useAppStore((s) => s.toast);

  const schedule: RoutineSchedule | null = useMemo(() => {
    if (kind === 'interval') {
      const n = Number(minutes);
      if (!Number.isInteger(n) || n < 1 || n > 20160) return null;
      return { kind: 'interval', minutes: n };
    }
    if (kind === 'commit' || kind === 'ci-failed' || kind === 'webhook') return { kind };
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time.trim())) return null;
    return kind === 'daily'
      ? { kind: 'daily', time: time.trim() }
      : { kind: 'weekly', weekday, time: time.trim() };
  }, [kind, minutes, time, weekday]);

  const headlessAgents = (Object.keys(agents) as AgentId[]).filter((id) => agents[id]?.capabilities.headless);

  const save = async () => {
    if (!schedule) {
      toast('error', 'Check the schedule (minutes 1..20160, time HH:MM).');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || 'Routine',
        projectId,
        agentId,
        prompt: prompt.trim(),
        schedule,
        enabled: true,
        freshContext,
      });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to save routine');
    } finally {
      setSaving(false);
    }
  };

  const canSave = prompt.trim().length > 0 && projectId !== '' && schedule !== null && !saving;

  return (
    <div className="flex flex-col gap-3.5 pb-2">
      <div>
        <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Name</label>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning build check" maxLength={80} />
      </div>

      <div>
        <label className="mb-1 block px-1 text-[12px] font-medium text-dim">What should the agent do?</label>
        <textarea
          className="field min-h-[84px]"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Check the build, summarize failures and open an issue if tests broke."
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Project</label>
          <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Agent</label>
          <select className="field" value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)}>
            {(headlessAgents.length ? headlessAgents : (['claude', 'zcode', 'codex'] as AgentId[])).map((id) => (
              <option key={id} value={id}>
                {agents[id]?.label ?? id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block px-1 text-[12px] font-medium text-dim">When (times are server time)</label>
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {WHEN.map(({ kind: k, label }) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={
                'press flex h-9 items-center justify-center rounded-xl border text-[12.5px] font-semibold ' +
                (kind === k ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line bg-surface-2 text-dim')
              }
            >
              {label}
            </button>
          ))}
        </div>
        {EVENT_HINTS[kind] ? (
          <p className="px-1 text-[12px] leading-relaxed text-dim">{EVENT_HINTS[kind]}</p>
        ) : kind === 'interval' ? (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-dim">every</span>
            <input
              className="field w-24 text-center"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <span className="text-[13px] text-dim">minutes</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              className="field w-28"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Time of day"
            />
            {kind === 'weekly' && (
              <div className="flex gap-1">
                {DAYS.map((day, i) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={weekday === i}
                    onClick={() => setWeekday(i as Weekday)}
                    className={
                      'press flex h-9 flex-1 items-center justify-center rounded-lg border text-[11px] font-semibold ' +
                      (weekday === i ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line bg-surface-2 text-dim')
                    }
                  >
                    {day}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <label className="flex items-start gap-2.5 px-1">
        <input
          type="checkbox"
          checked={freshContext}
          onChange={(e) => setFreshContext(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[#7C5CFF]"
        />
        <span className="text-[12.5px] leading-snug text-dim">
          <span className="font-medium text-ink">Fresh context each run</span> — the agent does not carry the earlier runs’
          conversation along. Cheaper for long-lived routines; the chat still shows every run.
        </span>
      </label>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="press tap flex-1 rounded-2xl py-2.5 text-[14px] font-semibold text-white disabled:opacity-45 btn-primary"
        >
          {saving ? <Loader2 size={15} className="mx-auto animate-spin" /> : routine ? 'Save changes' : 'Create routine'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="press tap flex-1 rounded-2xl border border-line bg-surface-2 py-2.5 text-[14px] font-semibold text-dim active:bg-surface-3"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
