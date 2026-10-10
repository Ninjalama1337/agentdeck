import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import type { Toast as ToastItem } from '../../store/appStore';

const ICONS = { info: Info, warn: AlertTriangle, error: AlertTriangle } as const;
const ACCENTS = { info: '#4E8CFF', warn: '#F59E0B', error: '#F43F5E' } as const;

function Toast({ toast }: { toast: ToastItem }) {
  const dismiss = useAppStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), 4200);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismiss]);

  const Icon = ICONS[toast.level];
  const accent = ACCENTS[toast.level];

  return (
    <div
      role="status"
      className="msg-in pointer-events-auto flex w-full max-w-xl items-start gap-2.5 rounded-2xl border p-3 pr-2 shadow-glass"
      style={{
        background: 'rgba(18, 22, 32, 0.92)',
        borderColor: `${accent}44`,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `${accent}1f`, color: accent }}
      >
        <Icon size={15} />
      </span>
      <p className="min-w-0 flex-1 break-words pt-1 text-[13.5px] leading-snug text-ink">{toast.text}</p>
      <button
        aria-label="Dismiss notification"
        className="tap flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-dim active:text-ink"
        onClick={() => dismiss(toast.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 safe-t">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}

/** Inline success flash used in buttons/lists. */
export function SuccessFlash({ text }: { text: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 1800);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ok">
      <Check size={13} /> {text}
    </span>
  );
}
