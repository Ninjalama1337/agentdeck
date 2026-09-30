import type { HTMLAttributes } from 'react';
import { clsx } from 'clsx';

export function GlassCard({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('glass p-4', className)} {...rest}>
      {children}
    </div>
  );
}
