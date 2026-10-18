import { ChevronUp, Coins, Sparkles } from 'lucide-react';
import type { AgentInfo, Session } from '@agentdeck/shared';

/** Friendly label for a thinking effort level ('default' → Auto). */
export function effortLabel(effort: string | undefined): string {
  if (!effort || effort === 'default') return 'Auto';
  if (effort === 'adaptive') return 'Adaptive';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Compact "1.2k" / "3.4M" formatting for token counts. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Slim, always-visible bar under the chat header: current model, thinking
 * effort and live usage (session tokens + remaining plan quota) at a glance.
 */
export function ModelBar({
  session,
  agent,
  running,
  sessionTokens,
  planRemainingPct,
  onOpen,
  onOpenUsage,
}: {
  session: Session;
  agent: AgentInfo | undefined;
  running: boolean;
  /** Summed in+out tokens of this session's messages (undefined = unknown). */
  sessionTokens?: { input: number; output: number };
  /** Remaining plan quota in percent (weekly limit; claude only for now). */
  planRemainingPct?: number;
  onOpen: () => void;
  onOpenUsage: () => void;
}) {
  const accent = agent?.accentColor ?? '#7C5CFF';
  const isDefault = session.model === undefined || session.model === 'inherit';
  const defaultModel = agent?.defaultModel;
  const modelLabel = isDefault
    ? (defaultModel?.label ?? 'Default model')
    : (agent?.models.find((m) => m.id === session.model)?.label ?? session.model);
  const effort = session.thinkingEffort ?? 'default';
  const showEffort = (agent?.efforts?.length ?? 0) > 0;
  const effortActive = showEffort && effort !== 'default';
  const tokensTotal = sessionTokens ? sessionTokens.input + sessionTokens.output : undefined;
  const planLow = planRemainingPct !== undefined && planRemainingPct <= 20;

  return (
    <div
      className="flex w-full items-stretch border-b border-line"
      style={{ background: 'var(--ad-bg-raise)' }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Model ${modelLabel}${isDefault ? ' (default)' : ''}, thinking ${effortLabel(effort)} — change`}
        title={isDefault && defaultModel ? `Default: ${defaultModel.id}` : undefined}
        className="press tap flex min-w-0 flex-1 items-center gap-2 px-3.5 py-[7px] text-left active:bg-white/[0.05]"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'pulse-dot' : ''}`}
          style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {modelLabel}
        </span>
        {showEffort && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] font-semibold"
            style={
              effortActive
                ? { color: accent, borderColor: `${accent}55`, background: `${accent}1f` }
                : { color: '#8D95A7', borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)' }
            }
          >
            <Sparkles size={11} aria-hidden />
            {effortLabel(effort)}
          </span>
        )}
        <ChevronUp size={14} className="shrink-0 text-dim" aria-hidden />
      </button>

      <button
        type="button"
        onClick={onOpenUsage}
        aria-label="Usage — session tokens, plan quota and reset times"
        className="press tap flex shrink-0 items-center gap-1.5 border-l border-line px-3 text-[11px] font-semibold text-dim active:bg-white/[0.05]"
      >
        <Coins size={12} aria-hidden className={running ? 'text-accent' : undefined} />
        {tokensTotal !== undefined && (
          <span className="tabular-nums text-ink/85">{compact(tokensTotal)}</span>
        )}
        {planRemainingPct !== undefined && (
          <span
            className={`tabular-nums ${planLow ? 'text-danger' : 'text-ok'}`}
            title="Remaining weekly plan quota — tap for details and reset times"
          >
            · {planRemainingPct}% left
          </span>
        )}
      </button>
    </div>
  );
}
