import { Wifi, WifiOff } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';

export function ConnectionPill({ className }: { className?: string }) {
  const connection = useAppStore((s) => s.connection);
  const online = connection === 'online';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        online ? 'border-ok/30 bg-ok/10 text-ok' : 'border-warn/30 bg-warn/10 text-warn',
        className,
      )}
      role="status"
    >
      {online ? <Wifi size={13} /> : <WifiOff size={13} />}
      {online ? 'Online' : 'Reconnecting…'}
    </span>
  );
}
