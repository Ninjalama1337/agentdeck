import { useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';

/**
 * Asks this (paired) device whether a device outside the server's network may
 * pair. Stays up until answered — the request itself expires on the server.
 */
export function PairApproval() {
  const request = useAppStore((s) => s.pairRequests[0]);
  const refreshPairRequests = useAppStore((s) => s.refreshPairRequests);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  if (!request) return null;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.decidePairRequest(request.id, approve);
      toast('info', approve ? `${request.deviceName} may pair` : 'Pairing denied');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
      await refreshPairRequests();
      if (approve) window.setTimeout(() => void refreshDevices(), 3000);
    }
  };

  return (
    <div className="modal-backdrop flex items-center justify-center p-5">
      <div role="alertdialog" aria-modal="true" aria-label="Pairing request" className="modal-card glass safe-b w-full max-w-xl p-5">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-warn/15 text-warn">
            <ShieldQuestion size={19} />
          </span>
          <h2 className="text-[16px] font-semibold">A new device wants to pair</h2>
        </div>
        <p className="text-[14px] font-medium">{request.deviceName}</p>
        <p className="text-[12.5px] text-dim">From outside your network · {request.ip}</p>
        <p className="mt-4 text-[12px] font-medium uppercase tracking-wider text-dim">Check number</p>
        <p className="font-mono text-[30px] font-semibold tracking-[0.25em]">{request.checkCode}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">
          Allow only if you are pairing that device right now and it shows the same number. A paired device can run
          agents and read your projects.
        </p>
        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(false)}
            className="press tap flex-1 rounded-2xl border border-danger/35 bg-danger/10 text-[14.5px] font-semibold text-danger disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(true)}
            className="press tap btn-primary flex-1 rounded-2xl text-[14.5px] font-semibold text-white disabled:opacity-50"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
