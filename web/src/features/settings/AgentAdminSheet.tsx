import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
  KeyRound,
  RefreshCw,
  Square,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { AGENT_LABELS } from '@agentdeck/shared';
import type { AdminJob, AdminJobKind, AdminJobStatus, AgentId } from '@agentdeck/shared';
import { ADMIN_KIND_LABELS, useAppStore } from '../../store/appStore';
import { api } from '../../api/client';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { formatElapsed, relTime } from '../../util/format';

const KIND_ICONS: Record<AdminJobKind, LucideIcon> = {
  update: RefreshCw,
  install: Download,
  login: KeyRound,
};

/** Pill colors per job status (running pulses via the shared .pulse-dot keyframes). */
const STATUS_STYLES: Record<AdminJobStatus, { pill: string; dot: string }> = {
  queued: { pill: 'border-line bg-white/[0.05] text-dim', dot: 'bg-dim' },
  running: { pill: 'border-accent/40 bg-accent/15 text-accent', dot: 'bg-accent pulse-dot' },
  done: { pill: 'border-ok/30 bg-ok/12 text-ok', dot: 'bg-ok' },
  error: { pill: 'border-danger/30 bg-danger/12 text-danger', dot: 'bg-danger' },
  stopped: { pill: 'border-line bg-white/[0.05] text-dim', dot: 'bg-dim' },
};

function isActive(job: AdminJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Self-ticking "2m" elapsed label (1 s interval while mounted) — used for the
 * running console header and the Settings "Running: …" line.
 */
export function ElapsedLabel({ from }: { from: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - from)}</span>;
}

function StatusPill({ status }: { status: AdminJobStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        s.pill,
      )}
    >
      <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {status}
    </span>
  );
}

/** Cancels the running job (POST /api/admin/jobs/:id/stop). */
function StopJobButton({ jobId }: { jobId: string }) {
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      await api.stopAdminJob(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      toast('warn', message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={busy}
      className="press tap flex h-6 items-center gap-1 rounded-full border border-danger/40 bg-danger/12 px-2.5 text-[10.5px] font-bold uppercase tracking-wide text-danger disabled:opacity-50"
    >
      <Square size={9} aria-hidden />
      Stop
    </button>
  );
}

/** Live console: mono pre on a dark surface, auto-scrolls only while the user
 *  sits at the bottom, capped client-side to the newest 500 lines. */
function JobConsole({ job }: { job: AdminJob }) {
  const preRef = useStickyScroll<HTMLPreElement>();
  const active = isActive(job);
  const lines = job.output.length > 500 ? job.output.slice(-500) : job.output;

  return (
    <div className="ml-1 mt-1.5">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-dim">
          {active ? (
            <>
              <span aria-hidden className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              live · <ElapsedLabel from={job.startedAt} />
            </>
          ) : (
            'output'
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-dim">{job.output.length} lines</span>
          {active && <StopJobButton jobId={job.id} />}
        </span>
      </div>
      <pre
        ref={preRef}
        className="no-scrollbar max-h-[48vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-2xl border border-line bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed text-ink/90"
      >
        {lines.length > 0 ? lines.join('\n') : 'Waiting for output…'}
      </pre>

      {job.kind === 'login' && active && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-dim">
          <Info size={12} className="mt-0.5 shrink-0" />
          Browser opens on the computer — this can take a moment; watch the output here.
        </p>
      )}
      {job.status === 'stopped' && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-dim">
          <Square size={12} className="mt-0.5 shrink-0" />
          Stopped from the app{job.error ? ` — ${job.error.trim()}` : ''}.
        </p>
      )}
      {job.status === 'done' && job.kind !== 'login' && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-dim">
          <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-ok" />
          Finished — the agent was re-detected; its card in Settings updates automatically.
        </p>
      )}
      {job.status === 'error' && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {job.error?.trim() || `Exited with code ${job.exitCode ?? 'unknown'}`}
        </p>
      )}
    </div>
  );
}

function JobRow({ job, expanded, onToggle }: { job: AdminJob; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="press tap flex w-full items-center gap-2.5 rounded-2xl border border-line bg-white/[0.04] px-3 py-2 text-left active:bg-white/[0.07]"
      >
        <StatusPill status={job.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold">{ADMIN_KIND_LABELS[job.kind]}</span>
          <span className="block truncate text-[11.5px] text-dim">
            started {relTime(job.startedAt)}
            {job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ''}
          </span>
        </span>
        {expanded ? (
          <ChevronDown size={15} className="shrink-0 text-dim" />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-dim" />
        )}
      </button>
      {expanded && <JobConsole job={job} />}
    </>
  );
}

/**
 * Per-agent admin sheet: update/install/login actions with live console output.
 * Jobs stream in via the `admin:job` WS event (store upserts once per event);
 * buttons lock globally while any job runs (server allows one at a time).
 */
export function AgentAdminSheet({
  agentId,
  open,
  onClose,
}: {
  agentId: AgentId | null;
  open: boolean;
  onClose: () => void;
}) {
  const agent = useAppStore((s) => (agentId ? s.agents[agentId] : undefined));
  const adminJobs = useAppStore((s) => s.adminJobs);
  const startAdminJob = useAppStore((s) => s.startAdminJob);

  const anyActive = adminJobs.some(isActive);
  const jobs = useMemo(() => adminJobs.filter((j) => j.agentId === agentId), [adminJobs, agentId]);
  const activeJobId = jobs.find(isActive)?.id;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Follow the newest active job of this agent (e.g. Install fired from the
  // row chip). A finished console stays expanded so results remain readable.
  useEffect(() => {
    if (open && activeJobId) setExpandedId(activeJobId);
  }, [open, activeJobId]);

  useEffect(() => {
    if (!open) setExpandedId(null);
  }, [open]);

  const caps = agent?.admin ?? [];
  const unavailable = caps.filter((c) => c.unavailableReason);

  const launch = (kind: AdminJobKind) => {
    if (!agentId) return;
    void startAdminJob(agentId, kind).catch(() => undefined); // store toasts the failure
  };

  const title = agentId ? (agent?.label ?? AGENT_LABELS[agentId]) : undefined;
  const subtitle = agent
    ? agent.available
      ? agent.version
        ? `v${agent.version}`
        : undefined
      : (agent.reason ?? 'Unavailable')
    : undefined;

  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle}>
      <div className="flex flex-col gap-4">
        {caps.length > 0 && (
          <section>
            <p className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wider text-dim">Maintenance</p>
            <div className="flex flex-wrap gap-2">
              {caps.map((cap) => {
                const Icon = KIND_ICONS[cap.kind];
                return (
                  <Button
                    key={cap.kind}
                    variant="primary"
                    size="sm"
                    className="h-11 px-4"
                    icon={<Icon size={15} />}
                    disabled={anyActive || Boolean(cap.unavailableReason)}
                    title={cap.unavailableReason}
                    onClick={() => launch(cap.kind)}
                  >
                    {ADMIN_KIND_LABELS[cap.kind]}
                  </Button>
                );
              })}
            </div>
            {anyActive && (
              <p className="mt-2 px-1 text-[11.5px] text-dim">
                An admin job is already running — actions unlock when it finishes.
              </p>
            )}
            {unavailable.map((cap) => (
              <p
                key={cap.kind}
                className="mt-2 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-dim"
              >
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-semibold">{ADMIN_KIND_LABELS[cap.kind]}</span> — {cap.unavailableReason}
                </span>
              </p>
            ))}
          </section>
        )}

        <section>
          <p className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wider text-dim">Jobs</p>
          {jobs.length === 0 ? (
            <p className="px-1 text-[12.5px] text-dim">
              No jobs yet{caps.length > 0 ? ' — run an action above' : ''}.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={expandedId === job.id}
                  onToggle={() => setExpandedId((cur) => (cur === job.id ? null : job.id))}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}
