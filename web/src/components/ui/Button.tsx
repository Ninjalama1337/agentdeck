import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';
import { Spinner } from './Spinner';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'glass' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  full?: boolean;
}

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'text-white shadow-glass bg-[linear-gradient(135deg,#7C5CFF_0%,#4E8CFF_100%)] hover:brightness-110 active:brightness-110',
  glass:
    'bg-surface-2 border border-line text-ink hover:bg-surface-3 active:bg-surface-3',
  ghost: 'text-dim hover:bg-white/[0.06] hover:text-ink active:text-ink active:bg-white/[0.06]',
  danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 active:bg-danger/25',
  subtle: 'bg-bg-raise text-ink hover:bg-surface-2 active:bg-surface-2',
};

const SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-9 px-3.5 text-[13px] rounded-xl gap-1.5',
  md: 'min-h-11 px-4 text-[15px] rounded-2xl gap-2',
  lg: 'min-h-13 px-5 text-base rounded-2xl gap-2',
};

export function Button({
  variant = 'glass',
  size = 'md',
  loading = false,
  icon,
  full,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'press tap inline-flex select-none items-center justify-center font-medium',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
}

/** Square icon-only button with 44px hit target. */
export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={clsx(
        'press tap flex h-11 w-11 items-center justify-center rounded-xl text-dim',
        'hover:bg-white/[0.08] hover:text-ink active:bg-white/[0.08] active:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
