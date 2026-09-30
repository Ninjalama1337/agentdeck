import type { ReactNode } from 'react';
import { clsx } from 'clsx';

interface MenuRowProps {
  /** 18px lucide icon with strokeWidth 1.8 — keep every caller consistent. */
  icon: ReactNode;
  label: string;
  /** Short dim one-liner under the label (omit for compact rows). */
  description?: string;
  danger?: boolean;
  onClick: () => void;
}

/**
 * Uniform action row for bottom-sheet menus (project sheet, session sheet).
 * One shared implementation so icon size, paddings and active states always
 * match between screens.
 */
export function MenuRow({ icon, label, description, danger, onClick }: MenuRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'press tap flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left active:bg-white/[0.08]',
        danger ? 'text-danger' : 'text-ink',
      )}
    >
      <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center', danger ? 'text-danger' : 'text-dim')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-medium leading-tight">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] leading-snug text-dim">{description}</span>}
      </span>
    </button>
  );
}
