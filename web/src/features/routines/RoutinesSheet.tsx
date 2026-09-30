import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Repeat, Trash2 } from 'lucide-react';
import type { AgentId, Routine, RoutineSchedule } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
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
                  </div>

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
                </div>
              );
            })
          )}
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ editor */

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
    routine?.schedule && routine.schedule.kind !== 'interval' ? routine.schedule.time : '09:00',
  );
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
        <label className="mb-1.5 block px-1 text-[12px] font-medium text-dim">Schedule (server time)</label>
        <div className="mb-2 flex gap-1.5">
          {(['interval', 'daily', 'weekly'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={
                'press flex h-9 flex-1 items-center justify-center rounded-xl border text-[12.5px] font-semibold ' +
                (kind === k ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line bg-surface-2 text-dim')
              }
            >
              {k === 'interval' ? 'Interval' : k === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
        {kind === 'interval' ? (
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
