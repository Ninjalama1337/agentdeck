import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-14 text-center">
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-line"
        style={{ background: 'rgba(124,92,255,0.1)', color: '#7C5CFF' }}
      >
        <Icon size={26} />
      </div>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1.5 max-w-[34ch] text-[13px] leading-relaxed text-dim">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
