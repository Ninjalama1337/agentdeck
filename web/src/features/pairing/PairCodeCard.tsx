import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';

/**
 * The server's current pairing code, for pairing another device from this
 * one. A code works once, so it is read again whenever a device was added or
 * asked for approval.
 */
export function PairCodeCard() {
  const deviceCount = useAppStore((s) => s.devices.length);
  const requestCount = useAppStore((s) => s.pairRequests.length);
  const toast = useAppStore((s) => s.toast);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .pairCode()
      .then((res) => alive && setCode(res.code))
      .catch(() => undefined); // older server: the card stays hidden
    return () => {
      alive = false;
    };
  }, [deviceCount, requestCount]);

  if (!code) return null;

  const renew = () => {
    setBusy(true);
    api
      .newPairCode()
      .then((res) => setCode(res.code))
      .catch((err: unknown) => toast('error', errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 rounded-2xl border border-line bg-white/[0.04] p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/[0.07] text-accent">
          <KeyRound size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11.5px] text-dim">Pairing code for another device</span>
          <span className="block font-mono text-[20px] font-semibold tracking-[0.2em]">{code}</span>
        </span>
        <button
          type="button"
          aria-label="New pairing code"
          disabled={busy}
          onClick={renew}
          className="tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:text-ink disabled:opacity-50"
        >
          <RefreshCw size={16} className={busy ? 'animate-spin' : undefined} />
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-dim">
        Works once. Outside the server's network, the new device also has to be allowed on a device that is already
        paired.
      </p>
    </div>
  );
}
