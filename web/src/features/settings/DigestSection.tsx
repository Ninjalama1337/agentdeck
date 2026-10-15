import { useEffect, useState } from 'react';
import { Sun } from 'lucide-react';
import type { DigestSettings } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Toggle } from './PreferencesSection';

/** The evening digest: on/off and when (older servers: hidden). */
export function DigestSection() {
  const [s, setS] = useState<DigestSettings | null>(null);

  useEffect(() => {
    void api.digest().then(setS).catch(() => undefined);
  }, []);

  if (!s) return null;

  const save = async (update: Partial<Pick<DigestSettings, 'enabled' | 'time'>>) => {
    try {
      setS(await api.setDigest(update));
    } catch (err) {
      useAppStore.getState().toast('error', errorMessage(err));
    }
  };

  return (
    <section className="glass mb-4 p-4" aria-label="Daily summary">
      <div className="flex items-start gap-3">
        <Sun size={18} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Evening summary</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">
            Once a day a notification with what the agents did: runs, commits, failures and cost. Quiet days send nothing.
          </p>
          <label className="mt-2 flex items-center gap-2 text-[12.5px] text-dim">
            At
            <input
              type="time"
              value={s.time}
              disabled={!s.enabled}
              onChange={(e) => e.target.value && void save({ time: e.target.value })}
              className="rounded-lg border border-line bg-black/30 px-2 py-1 text-[13px] text-ink outline-none disabled:opacity-50"
            />
            <span>(the computer's clock)</span>
          </label>
        </div>
        <Toggle label="Evening summary" checked={s.enabled} onChange={(v) => void save({ enabled: v })} />
      </div>
    </section>
  );
}
