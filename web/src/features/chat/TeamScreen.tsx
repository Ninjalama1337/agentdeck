import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  Clock,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { TeamStep, TeamStepStatus } from '@agentdeck/shared';
import { api, ApiError } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Chip } from '../../components/ui/Chip';
import { relTime } from '../../util/format';

/** Live timeline of a team run (steps are real sessions — openable inline). */
export function TeamScreen({ runId }: { runId: string }) {
  const run = useAppStore((s) => s.teamRuns.find((r) => r.id === runId));
  const upsertTeamRun = useAppStore((s) => s.upsertTeamRun);
  const projects = useAppStore((s) => s.projects);
  const agents = useAppStore((s) => s.agents);
  const openSession = useAppStore((s) => s.openSession);
  const navigate = useAppStore((s) => s.navigate);
  const toast = useAppStore((s) => s.toast);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // refresh once on mount; live updates arrive via team:update
    api
      .teamRun(runId)
      .then(upsertTeamRun)
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 404)) toast('error', errorMessage(err));
      });
  }, [runId, upsertTeamRun, toast]);

  const projectName = run ? (projects.find((p) => p.id === run.projectId)?.name ?? run.projectId) : '';

  const openStep = async (step: TeamStep) => {
    if (!step.sessionId) return;
    try {
      await openSession(step.sessionId);
      navigate({ name: 'chat' });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  return (
    <div className="safe-t flex min-h-full flex-col px-4 pb-8">
      <header className="flex items-center gap-2 py-4">
        <button
          type="button"
          aria-label="Back to chat"
          onClick={() => navigate({ name: 'chat' })}
          className="tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/10 active:text-ink"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-bold leading-tight">{run?.title ?? 'Team run'}</h1>
          <p className="truncate text-[12px] text-dim">
            {run ? `${projectName} · ${run.mode} · ${relTime(run.createdAt)}` : 'Loading…'}
          </p>
        </div>
        {run && <RunStatusChip status={run.status} />}
      </header>

      {!run ? (
        <div className="flex justify-center py-16">
          <Loader2 size={22} className="animate-spin text-dim" />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {run.steps.map((step, index) => {
            const agent = agents[step.agentId];
            const expanded = openSteps[step.id] ?? false;
            const isLast = index === run.steps.length - 1;
            return (
              <div key={step.id} className="flex gap-3">
                {/* rail */}
                <div className="flex flex-col items-center pt-3">
                  <StepStatusIcon status={step.status} />
                  {!isLast && <span className="w-px flex-1 bg-line" />}
                </div>

                {/* card */}
                <div className="glass mb-1 min-w-0 flex-1 p-3.5">
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar agent={agent} agentId={step.agentId} size="sm" glow={step.status === 'running'} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold">{agent?.label ?? step.agentId}</p>
                      <p className="text-[11.5px] text-dim">{STEP_LABELS[step.status]}</p>
                    </div>
                    {step.sessionId && (
                      <button
                        type="button"
                        onClick={() => void openStep(step)}
                        className="press tap flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-accent/15 px-3 text-[12px] font-semibold text-accent"
                      >
                        <MessageSquare size={13} /> Chat
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setOpenSteps((prev) => ({ ...prev, [step.id]: !expanded }))}
                    className="mt-2.5 flex w-full items-start gap-1.5 text-left"
                    aria-expanded={expanded}
                  >
                    <p className={clsx('min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-dim', !expanded && 'clamp-4')}>
                      {step.prompt}
                    </p>
                    <ChevronDown size={14} className={clsx('mt-0.5 shrink-0 text-dim transition-transform', expanded && 'rotate-180')} />
                  </button>

                  {(step.resultSummary || step.error) && (
                    <div
                      className={clsx(
                        'mt-2.5 rounded-xl border p-2.5 text-[12.5px] leading-relaxed',
                        step.error ? 'border-danger/30 bg-danger/10 text-danger' : 'border-ok/25 bg-ok/8 text-ink/90',
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{step.error ?? step.resultSummary}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {run.steps.length === 0 && <p className="py-8 text-center text-[13px] text-dim">This run has no steps.</p>}
        </div>
      )}
    </div>
  );
}

const STEP_LABELS: Record<TeamStepStatus, string> = {
  pending: 'Pending',
  running: 'Running…',
  done: 'Done',
  error: 'Failed',
  skipped: 'Skipped',
};

function StepStatusIcon({ status }: { status: TeamStepStatus }) {
  if (status === 'running') {
    return (
      <span className="flex h-6 w-6 items-center justify-center">
        <Loader2 size={17} className="animate-spin text-accent" />
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok/15 text-ok">
        <Check size={13} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-danger/15 text-danger">
        <X size={13} />
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-dim">
        <AlertTriangle size={12} />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full text-dim">
      <Circle size={13} />
    </span>
  );
}

function RunStatusChip({ status }: { status: 'pending' | 'running' | 'done' | 'error' | 'stopped' }) {
  const map = {
    pending: { label: 'Queued', tone: 'warn' as const, icon: Clock },
    running: { label: 'Running', tone: 'accent' as const, icon: Loader2 },
    done: { label: 'Done', tone: 'ok' as const, icon: Check },
    error: { label: 'Failed', tone: 'danger' as const, icon: X },
    stopped: { label: 'Stopped', tone: 'default' as const, icon: X },
  };
  const { label, tone, icon: Icon } = map[status];
  return (
    <Chip tone={tone}>
      <Icon size={11} className={status === 'running' ? 'animate-spin' : ''} />
      {label}
    </Chip>
  );
}
