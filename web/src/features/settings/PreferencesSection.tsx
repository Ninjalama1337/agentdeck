import { useEffect, useState } from 'react';
import { Bell, BellRing, Mic, SquareTerminal, Vibrate } from 'lucide-react';
import { clsx } from 'clsx';
import type { DeckNotificationKind, VoiceStatus } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { usePrefs, type DictationEngine } from '../../store/prefs';
import { disablePush, enablePush, permissionState, pushSupported, requestPermission, type Permission } from '../../util/notify';
import { speechCtor } from '../../hooks/useDictation';
import { isNativePlatform } from '../../util/platform';
import { haptic } from '../../util/haptics';

const KIND_LABELS: Record<DeckNotificationKind, string> = {
  'session-done': 'Agent finished',
  'session-error': 'Agent failed',
  'terminal-attention': 'Terminal waiting for input',
  'team-done': 'Team run finished',
  'team-error': 'Team run failed',
  info: 'Other',
};

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => {
        haptic();
        onChange(!checked);
      }}
      className={clsx(
        'relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        className={clsx(
          'absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

function Row({ icon, title, hint, children }: { icon?: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 py-1.5">
      {icon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-dim">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        {hint && <span className="block text-[12px] leading-snug text-dim">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="grid rounded-xl border border-line bg-bg-raise p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx('press h-8 rounded-[10px] px-2 text-[12.5px] font-semibold', value === o.value ? 'bg-surface-3 text-ink' : 'text-dim')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Notifications, dictation, terminal and feel — all per device. */
export function PreferencesSection() {
  const prefs = usePrefs();
  const toast = useAppStore((s) => s.toast);
  const pushActive = useAppStore((s) => s.pushActive);
  const refreshPushActive = useAppStore((s) => s.refreshPushActive);
  const [perm, setPerm] = useState<Permission>('default');
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);

  useEffect(() => {
    void permissionState().then(setPerm);
    void api.voiceStatus().then(setVoice).catch(() => setVoice(null));
  }, []);

  const native = isNativePlatform();
  const canPush = pushSupported();

  const toggleNotifications = async (on: boolean) => {
    prefs.set('notifications', on);
    if (!on) {
      await disablePush();
      await refreshPushActive();
      return;
    }
    setBusy(true);
    try {
      if (canPush) {
        const res = await enablePush();
        if (res === 'subscribed') toast('info', 'Push enabled — you will be notified even with the app closed');
        else if (res === 'denied') toast('warn', 'Notifications are blocked for this site in the browser settings');
        else if (res === 'server-disabled') toast('warn', 'Server has no push keys');
        else if (res === 'error') toast('error', 'Could not register for push');
      } else {
        const p = await requestPermission();
        if (p === 'denied') toast('warn', 'Notifications are blocked — allow them in system settings');
        if (p === 'unsupported')
          toast('warn', native ? 'This APK build lacks the notification plugin' : 'Push needs HTTPS (e.g. the Cloudflare tunnel)');
      }
    } finally {
      setPerm(await permissionState());
      await refreshPushActive();
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const { delivered } = await api.pushTest();
      if (delivered === 0) toast('warn', 'No push subscription for this device — enable notifications first');
      else toast('info', 'Test sent — lock the phone to see it arrive');
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const deviceSpeech = speechCtor() !== null;

  return (
    <>
      <section className="glass mb-4 p-4" aria-label="Notifications">
        <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
          <Bell size={15} className="text-accent" /> Notifications
        </h2>
        <Row
          title="Notify me"
          hint={
            pushActive
              ? 'Web Push active — works with the app closed'
              : perm === 'granted'
                ? native
                  ? 'Shown while the app runs in the background'
                  : canPush
                    ? 'Enabled while the app is open — toggle to register push'
                    : 'Shown while the app is open (push needs HTTPS)'
                : perm === 'denied'
                  ? 'Blocked in browser/system settings'
                  : 'Finished runs, failures, terminals waiting for you'
          }
        >
          <Toggle label="Notifications" checked={prefs.notifications && perm === 'granted'} onChange={(v) => void toggleNotifications(v)} />
        </Row>
        {busy && <p className="text-[12px] text-dim">Registering…</p>}
        <div className="mt-1 border-t border-line pt-1">
          {(Object.keys(KIND_LABELS) as DeckNotificationKind[]).map((k) => (
            <Row key={k} title={KIND_LABELS[k]}>
              <Toggle label={KIND_LABELS[k]} checked={prefs.notifyKinds[k]} onChange={(v) => prefs.set('notifyKinds', { ...prefs.notifyKinds, [k]: v })} />
            </Row>
          ))}
        </div>
        {pushActive && (
          <button type="button" onClick={() => void test()} className="press tap mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-surface-2 text-[13.5px] font-semibold">
            <BellRing size={15} /> Send test push
          </button>
        )}
      </section>

      <section className="glass mb-4 p-4" aria-label="Dictation">
        <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
          <Mic size={15} className="text-accent" /> Dictation
        </h2>
        <p className="mb-3 text-[12px] leading-snug text-dim">
          Device: {deviceSpeech ? 'on-device speech recognition available (live words)' : 'no recognizer in this WebView'} · Server:{' '}
          {voice?.available ? `Whisper via ${voice.provider}` : (voice?.reason ?? 'unknown')}
        </p>
        <Segmented<DictationEngine>
          value={prefs.dictation}
          onChange={(v) => prefs.set('dictation', v)}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'device', label: 'Device' },
            { value: 'server', label: 'Whisper' },
          ]}
        />
        <label className="mt-3 flex items-center gap-3">
          <span className="min-w-0 flex-1 text-[14px] font-medium">Language</span>
          <select
            value={prefs.dictationLang}
            onChange={(e) => prefs.set('dictationLang', e.target.value)}
            className="field !w-auto !py-2 text-[13.5px]"
          >
            <option value="">Device ({navigator.language})</option>
            <option value="de-DE">Deutsch</option>
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="fr-FR">Français</option>
            <option value="es-ES">Español</option>
            <option value="it-IT">Italiano</option>
          </select>
        </label>
      </section>

      <section className="glass mb-4 p-4" aria-label="Terminal and feel">
        <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
          <SquareTerminal size={15} className="text-accent" /> Terminal & feel
        </h2>
        <Row title="Compose bar" hint="Type in a phone-friendly input (autocorrect, dictation) instead of directly into the terminal">
          <Toggle label="Compose bar" checked={prefs.termCompose} onChange={(v) => prefs.set('termCompose', v)} />
        </Row>
        <Row title="Font size" hint="Pinch the terminal to zoom, too">
          <div className="flex items-center gap-1.5">
            <button type="button" className="kbd" onClick={() => prefs.set('termFontSize', Math.max(8, prefs.termFontSize - 1))}>
              −
            </button>
            <span className="w-8 text-center font-mono text-[13px]">{prefs.termFontSize}</span>
            <button type="button" className="kbd" onClick={() => prefs.set('termFontSize', Math.min(22, prefs.termFontSize + 1))}>
              +
            </button>
          </div>
        </Row>
        <Row icon={<Vibrate size={15} />} title="Haptics" hint="Short vibration on taps and events">
          <Toggle label="Haptics" checked={prefs.haptics} onChange={(v) => prefs.set('haptics', v)} />
        </Row>
        <Row title="Enter sends chat messages" hint="For hardware keyboards — on phones Enter adds a new line">
          <Toggle label="Enter sends" checked={prefs.enterToSend} onChange={(v) => prefs.set('enterToSend', v)} />
        </Row>
      </section>
    </>
  );
}
