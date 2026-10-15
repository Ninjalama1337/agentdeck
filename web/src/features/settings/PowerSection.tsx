import { useEffect, useState } from 'react';
import { Coffee } from 'lucide-react';
import type { PowerStatus } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { relTime } from '../../util/format';
import { Toggle } from './PreferencesSection';

/** Keep the server machine awake while agents work (older servers: hidden). */
export function PowerSection() {
  const [status, setStatus] = useState<PowerStatus | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => void api.power().then((s) => live && setStatus(s)).catch(() => undefined);
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  if (!status) return null;

  const set = async (keepAwake: boolean) => {
    try {
      setStatus(await api.setPower(keepAwake));
    } catch (err) {
      useAppStore.getState().toast('error', errorMessage(err));
    }
  };

  const state = !status.supported
    ? 'Not supported on this server (needs systemd-inhibit or caffeinate).'
    : status.error
      ? `The system refused: ${status.error}`
      : status.active
        ? `Awake now — ${status.reason ?? 'agents working'}${status.since ? `, since ${relTime(status.since)}` : ''}.`
        : 'Idle — the computer may sleep as usual.';

  return (
    <section className="glass mb-4 p-4" aria-label="Keep awake">
      <div className="flex items-start gap-3">
        <Coffee size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Keep the computer awake while agents work</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">
            No sleep while a terminal agent or chat is running, and for 3 minutes after. {state}
          </p>
        </div>
        <Toggle label="Keep awake" checked={status.enabled} disabled={!status.supported} onChange={(v) => void set(v)} />
      </div>
    </section>
  );
}
