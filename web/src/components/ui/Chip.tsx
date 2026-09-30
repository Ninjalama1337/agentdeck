import type { ReactNode } from 'react';
import { clsx } from 'clsx';

type Tone = 'default' | 'accent' | 'ok' | 'warn' | 'danger' | 'agent';

const TONES: Record<Tone, string> = {
  default: 'bg-white/[0.06] border-line text-dim',
  accent: 'bg-accent/15 border-accent/30 text-accent',
  ok: 'bg-ok/12 border-ok/30 text-ok',
  warn: 'bg-warn/12 border-warn/30 text-warn',
  danger: 'bg-danger/12 border-danger/30 text-danger',
  agent: 'border-white/10 text-ink',
};

interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  dot?: string;
  className?: string;
  title?: string;
}

export function Chip({ children, tone = 'default', dot, className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tone === 'agent' && 'bg-white/[0.06]',
        TONES[tone],
        className,
      )}
      style={tone === 'agent' && dot ? { color: dot, borderColor: `${dot}44`, background: `${dot}18` } : undefined}
    >
      {dot ? (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: dot, boxShadow: `0 0 8px ${dot}88` }}
        />
      ) : null}
      {children}
    </span>
  );
}
