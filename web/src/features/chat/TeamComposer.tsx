import { useState } from 'react';
import { ArrowRight, Loader2, Plus, Trash2, Users, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentId, AgentInfo } from '@agentdeck/shared';
import { AGENT_ACCENTS } from '@agentdeck/shared';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Chip } from '../../components/ui/Chip';
import { SwitchRow } from '../projects/NewProjectSheet';

interface Step {
  key: number;
  agentId: AgentId | undefined;
  prompt: string;
}

let stepSeq = 0;

/** Multi-agent pipeline composer → POST /api/team/runs. */
export function TeamComposer({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const agents = useAppStore((s) => s.agents);
  const agentOrder = useAppStore((s) => s.agentOrder);
  const launchTeam = useAppStore((s) => s.launchTeam);
  const upsertTeamRun = useAppStore((s) => s.upsertTeamRun);
  const navigate = useAppStore((s) => s.navigate);
  const toast = useAppStore((s) => s.toast);

  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'sequence' | 'parallel'>('sequence');
  const [passContext, setPassContext] = useState(true);
  const [steps, setSteps] = useState<Step[]>([{ key: ++stepSeq, agentId: undefined, prompt: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headless = agentOrder
    .map((id) => agents[id])
    .filter((a): a is NonNullable<typeof a> => a !== undefined && a.available && a.capabilities.headless);
  const valid = steps.some((s) => s.agentId && s.prompt.trim());

  const patchStep = (key: number, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const launch = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await launchTeam({
        projectId,
        title: title.trim() || undefined,
        mode,
        passContext: mode === 'sequence' ? passContext : undefined,
        steps: steps
          .filter((s) => s.agentId && s.prompt.trim())
          .map((s) => ({ agentId: s.agentId as AgentId, prompt: s.prompt.trim() })),
      });
      upsertTeamRun(run);
      onClose();
      navigate({ name: 'team', runId: run.id });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Team run" subtitle="Chain agents into a pipeline">
      <div className="flex flex-col gap-4">
        <input
          className="field"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Run title (optional) — e.g. “Refactor auth module”"
          autoComplete="off"
        />

        {/* mode toggle */}
        <div className="flex rounded-2xl border border-line bg-white/[0.04] p-1">
          {(
            [
              { key: 'sequence', label: 'Sequence', icon: ArrowRight, hint: 'One after another' },
              { key: 'parallel', label: 'Parallel', icon: Zap, hint: 'All at once' },
            ] as const
          ).map(({ key, label, icon: Icon, hint }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={clsx(
                'press tap flex flex-1 flex-col items-center rounded-xl py-1.5',
                mode === key ? 'bg-accent/20' : '',
              )}
            >
              <span className={clsx('flex items-center gap-1.5 text-[13.5px] font-semibold', mode === key ? 'text-ink' : 'text-dim')}>
                <Icon size={14} /> {label}
              </span>
              <span className="text-[10.5px] text-dim">{hint}</span>
            </button>
          ))}
        </div>

        {mode === 'sequence' && (
          <SwitchRow
            label="Pass context"
            hint="Each step sees the previous steps' results"
            checked={passContext}
            onChange={setPassContext}
          />
        )}

        {/* steps */}
        <div className="flex flex-col gap-3">
          {steps.map((step, index) => {
            const agent = step.agentId ? agents[step.agentId] : undefined;
            const accent = agent ? agent.accentColor || AGENT_ACCENTS[agent.id] : '#7C5CFF';
            return (
              <div key={step.key} className="glass-soft flex flex-col gap-2.5 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold"
                    style={{ background: `${accent}22`, color: accent }}
                  >
                    {index + 1}
                  </span>
                  <AgentChipSelect value={step.agentId} headless={headless} onChange={(id) => patchStep(step.key, { agentId: id })} />
                  {steps.length > 1 && (
                    <button
                      type="button"
                      aria-label="Remove step"
                      onClick={() => setSteps((prev) => prev.filter((s) => s.key !== step.key))}
                      className="tap ml-auto flex h-9 w-9 items-center justify-center rounded-xl text-dim active:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
                <textarea
                  className="field min-h-[64px] text-[13.5px]"
                  value={step.prompt}
                  onChange={(e) => patchStep(step.key, { prompt: e.target.value })}
                  placeholder={`What should ${agent?.label ?? 'this agent'} do?`}
                  rows={2}
                />
              </div>
            );
          })}

          {steps.length < 5 && (
            <button
              type="button"
              onClick={() => setSteps((prev) => [...prev, { key: ++stepSeq, agentId: undefined, prompt: '' }])}
              className="press tap flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line text-[13.5px] font-medium text-dim active:text-ink"
            >
              <Plus size={15} /> Add step
            </button>
          )}
        </div>

        {headless.length === 0 && (
          <Chip tone="warn">No headless-capable agents available — team runs need at least one.</Chip>
        )}
        {error && (
          <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!valid || busy || headless.length === 0}
          onClick={() => void launch()}
          className="press tap flex items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40 btn-primary"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Users size={16} />}
          Launch team run
        </button>
      </div>
    </Sheet>
  );
}

function AgentChipSelect({
  value,
  headless,
  onChange,
}: {
  value: AgentId | undefined;
  headless: AgentInfo[];
  onChange: (id: AgentId) => void;
}) {
  return (
    <div className="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto">
      {headless.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onChange(a.id)}
          className={clsx(
            'press flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12.5px] font-medium',
            value === a.id ? 'text-ink' : 'border-line bg-white/[0.04] text-dim',
          )}
          style={value === a.id ? { borderColor: `${a.accentColor}66`, background: `${a.accentColor}1e` } : undefined}
        >
          <AgentAvatar agent={a} agentId={a.id} size="xs" glow={false} />
          {a.label}
        </button>
      ))}
    </div>
  );
}
