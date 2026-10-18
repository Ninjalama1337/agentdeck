/**
 * The agent's plan as a checklist (Claude TodoWrite, Codex update_plan,
 * OpenCode todowrite). Shown in the live answer and, compact, above the
 * composer so the current step stays visible while you read or type.
 */
import { useState } from 'react';
import { Check, ChevronDown, Circle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { PlanItem } from '@agentdeck/shared';

export interface PlanProgress {
  done: number;
  total: number;
  /** The step the agent is on, if it marked one. */
  current?: string;
  pct: number;
}

export function planProgress(items: PlanItem[] | undefined): PlanProgress {
  const total = items?.length ?? 0;
  const done = items?.filter((item) => item.status === 'completed').length ?? 0;
  const current = items?.find((item) => item.status === 'in_progress')?.text;
  return { done, total, ...(current ? { current } : {}), pct: total ? Math.round((done / total) * 100) : 0 };
}

function PlanRow({ item, accent }: { item: PlanItem; accent: string }) {
  return (
    <li
      className={clsx(
        'flex items-start gap-2 text-[12.5px] leading-snug',
        item.status === 'completed' && 'text-dim/70 line-through',
      )}
    >
      {item.status === 'completed' ? (
        <Check size={13} className="mt-0.5 shrink-0 text-ok" aria-label="Done" />
      ) : item.status === 'in_progress' ? (
        <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" style={{ color: accent }} aria-label="In progress" />
      ) : (
        <Circle size={13} className="mt-0.5 shrink-0 text-dim/50" aria-label="Pending" />
      )}
      <span className="min-w-0 break-words">{item.text}</span>
    </li>
  );
}

/** Full checklist inside the live answer. */
export function PlanChecklist({ items, accent }: { items?: PlanItem[]; accent: string }) {
  if (!items?.length) return null;
  const progress = planProgress(items);
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-white/[0.03]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11.5px] font-medium text-dim">Plan</span>
        <span className="text-[11px] tabular-nums text-dim/70">
          {progress.done}/{progress.total}
        </span>
        <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <span
            className="block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${progress.pct}%`, background: accent }}
          />
        </span>
      </div>
      <ul className="flex flex-col gap-1 border-t border-line px-3 py-2">
        {items.map((item, i) => (
          <PlanRow key={`${i}-${item.text}`} item={item} accent={accent} />
        ))}
      </ul>
    </div>
  );
}

/** One-line task strip above the composer; tap to see every step. */
export function TaskStrip({ items, accent }: { items?: PlanItem[]; accent: string }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const progress = planProgress(items);
  const label = progress.current ?? (progress.total > 0 && progress.done === progress.total ? 'Plan complete' : 'Plan');
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-line bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Show the plan"
        className="press tap flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full pulse-dot" style={{ background: accent }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{label}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-dim/70">
          {progress.done}/{progress.total}
        </span>
        <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <span className="block h-full rounded-full" style={{ width: `${progress.pct}%`, background: accent }} />
        </span>
        <ChevronDown
          size={13}
          className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="flex flex-col gap-1 border-t border-line px-3 py-2">
          {items.map((item, i) => (
            <PlanRow key={`${i}-${item.text}`} item={item} accent={accent} />
          ))}
        </ul>
      )}
    </div>
  );
}
