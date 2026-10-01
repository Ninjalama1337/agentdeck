import { useEffect, useState } from 'react';
import { Check, Sparkles, Wand2, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentInfo, ModelPreset, Session } from '@agentdeck/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';
import { effortLabel } from './ModelBar';

/** Pick a model + thinking effort for the current session. Applies on next turn. */
export function ModelSheet({
  open,
  onClose,
  session,
  agent,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  agent: AgentInfo | undefined;
}) {
  const setSessionModel = useAppStore((s) => s.setSessionModel);
  const setSessionEffort = useAppStore((s) => s.setSessionEffort);
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const toast = useAppStore((s) => s.toast);
  const [presets, setPresets] = useState<ModelPreset[]>(agent?.models ?? []);
  const [custom, setCustom] = useState('');
  const [switchingPlan, setSwitchingPlan] = useState<string | null>(null);

  useEffect(() => {
    setPresets(agent?.models ?? []);
    if (!open || !agent) return;
    // refresh from /api/models/:agentId; fall back to AgentInfo.models
    api
      .models(agent.id)
      .then((res) => setPresets(res.models))
      .catch(() => {
        /* keep AgentInfo.models */
      });
  }, [open, agent]);

  const current = session.model;
  const locked = session.status === 'running' || session.status === 'queued';
  const efforts = agent?.efforts ?? [];
  const effort = session.thinkingEffort ?? 'default';
  const zcodeUsage = agent?.id === 'zcode' ? usage?.find((u) => u.agentId === 'zcode') : undefined;

  const pick = (model: string | undefined) => {
    if (locked) return;
    setSessionModel(session.id, model);
    onClose();
  };

  const pickEffort = (level: string) => {
    if (locked) return;
    setSessionEffort(session.id, level === 'default' ? 'default' : level);
  };

  return (
    <>
      {agent?.id === 'zcode' && zcodeUsage?.plans && zcodeUsage.plans.length > 0 && (
        <div className="mb-3 rounded-2xl border border-line bg-white/[0.03] p-3">
          <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-dim">
            <span className="flex items-center gap-1.5 uppercase tracking-wider text-ink">
              <Zap size={12} className="text-accent" />
              ZCode Modus
            </span>
            <span className="text-[11px] text-dim">{zcodeUsage.activePlanId === 'subscription' ? 'Abo aktiv' : 'Free Tokens aktiv'}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {zcodeUsage.plans.map((p) => {
              const active = p.active;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={locked || switchingPlan !== null}
                  onClick={async () => {
                    if (active) return;
                    setSwitchingPlan(p.id);
                    try {
                      await api.switchPlan('zcode', p.id);
                      toast('ok', `ZCode Modus gewechselt: ${p.label}`);
                      await refreshUsage();
                    } catch (e) {
                      toast('error', (e as Error).message);
                    } finally {
                      setSwitchingPlan(null);
                    }
                  }}
                  className={clsx(
                    'press tap flex flex-col items-start rounded-xl border p-2 text-left transition-all',
                    active
                      ? 'border-accent/60 bg-accent/20 text-ink shadow-[0_0_12px_rgba(124,92,255,0.2)]'
                      : 'border-line/70 bg-white/[0.02] text-dim hover:text-ink',
                    locked && 'opacity-50',
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-[12.5px] font-semibold">{p.id === 'subscription' ? 'Abo-Modell' : 'Free Tokens'}</span>
                    {active && <Check size={12} className="text-accent" />}
                  </div>
                  <span className="mt-0.5 truncate text-[11px] opacity-75">{p.id === 'subscription' ? 'Unbegrenzt' : '100M Tokens'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <ModelRow label="Agent default" description="Adapter's built-in model" selected={current === undefined} onClick={() => pick(undefined)} />
        {presets.map((preset) => (
          <ModelRow
            key={preset.id}
            label={preset.label}
            description={preset.description ?? preset.id}
            mono={preset.id}
            selected={current === preset.id}
            onClick={() => pick(preset.id)}
          />
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          className="field flex-1 font-mono text-[13px]"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom model id…"
          autoComplete="off"
          spellCheck={false}
          disabled={locked}
        />
        <button
          type="button"
          disabled={!custom.trim() || locked}
          onClick={() => pick(custom.trim())}
          className="press tap shrink-0 rounded-[14px] bg-accent/20 px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
        >
          Use
        </button>
      </div>

      {efforts.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium uppercase tracking-wider text-dim">
            <Sparkles size={12} aria-hidden />
            Thinking effort
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Thinking effort">
            {efforts.map((level) => {
              const selected = effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  disabled={locked}
                  onClick={() => pickEffort(level)}
                  className={clsx(
                    'press tap flex h-10 min-w-[72px] items-center justify-center gap-1 rounded-[14px] border text-[13px] font-semibold capitalize',
                    selected
                      ? 'border-accent/60 bg-accent/25 text-ink shadow-[0_0_16px_rgba(124,92,255,0.25)]'
                      : 'border-line bg-white/[0.04] text-dim',
                    locked && 'opacity-50',
                  )}
                >
                  {effortLabel(level)}
                  {selected && <Check size={13} aria-hidden />}
                </button>
              );
            })}
          </div>
          <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-dim">
            Higher effort thinks longer (better for complex work, slower + more quota). Auto uses the
            CLI default. Applies from your next message.
          </p>
        </section>
      )}

      <p className="mt-3 flex items-start gap-1.5 px-1 text-[12px] leading-relaxed text-dim">
        <Wand2 size={13} className="mt-0.5 shrink-0" />
        {locked
          ? 'A run is active — model and effort are locked until it finishes.'
          : 'Changes take effect on your next message. They also become the default for new sessions with this agent.'}
      </p>
    </>
  );
}

function ModelRow({
  label,
  description,
  mono,
  selected,
  onClick,
}: {
  label: string;
  description?: string;
  mono?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'press tap flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left',
        selected ? 'border-accent/45 bg-accent/12' : 'border-line bg-white/[0.04]',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{label}</span>
        {description && <span className={clsx('block truncate text-[11.5px] text-dim', mono && 'font-mono')}>{description}</span>}
      </span>
      {selected && <Check size={16} className="shrink-0 text-accent" />}
    </button>
  );
}
