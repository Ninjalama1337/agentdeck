import { useEffect, useRef, useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { clsx } from 'clsx';
import type { DesktopBridge, DesktopServiceAction, DesktopSettings } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Row, Segmented, Toggle } from './PreferencesSection';
import {
  CLOSE_ACTIONS,
  closeActionHint,
  confirmStep,
  createDesktopController,
  serviceActions,
  summarizeServer,
  type DesktopController,
  type DesktopState,
} from './desktopSettings';

const TONE_DOT = { ok: 'bg-ok', warn: 'bg-warn', dim: 'bg-dim' } as const;

/**
 * Settings → Desktop app. Only rendered inside the desktop shell (where
 * `window.agentdeckDesktop` exists): what closing the window does, phone
 * access in the LAN, start at login, and the state of the background service.
 */
export function DesktopSection({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<DesktopState>({ settings: null, status: null, busy: null });
  const controller = useRef<DesktopController | null>(null);
  /** A LAN switch waits for its confirmation: it restarts the server. */
  const [lanPending, setLanPending] = useState<boolean | null>(null);
  const [armed, setArmed] = useState<DesktopServiceAction | null>(null);

  useEffect(() => {
    const c = createDesktopController(bridge, (message) => useAppStore.getState().toast('error', message));
    controller.current = c;
    const off = c.subscribe(() => setState(c.getState()));
    setState(c.getState());
    return () => {
      off();
      c.dispose();
      controller.current = null;
    };
  }, [bridge]);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3500);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const { settings, status, busy } = state;
  const update = (patch: Partial<DesktopSettings>) => controller.current?.update(patch);
  const summary = status ? summarizeServer(status) : null;
  const actions = serviceActions(status);
  const lan = lanPending ?? settings?.lanAccess ?? false;

  const runAction = (action: DesktopServiceAction) => {
    const step = confirmStep(armed, action);
    setArmed(step.armed);
    if (step.run) void controller.current?.run(action);
  };

  return (
    <section className="glass mb-4 p-4" aria-label="Desktop app">
      <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
        <Monitor size={15} className="text-accent" /> Desktop app
        <span className="ml-auto font-mono text-[11px] font-normal text-dim">v{bridge.appVersion}</span>
      </h2>

      {!settings ? (
        <div className="skeleton my-2 h-24" aria-label="Loading desktop settings" />
      ) : (
        <>
          <div className="py-1.5">
            <p className="mb-2 text-[14px] font-medium">When the window is closed</p>
            <Segmented
              value={settings.closeAction}
              onChange={(closeAction) => void update({ closeAction })}
              options={CLOSE_ACTIONS.map(({ value, label }) => ({ value, label }))}
            />
            <p className="mt-1.5 text-[12px] leading-snug text-dim">{closeActionHint(settings.closeAction)}</p>
          </div>

          <Row title="Start at login" hint="Starts AgentDeck when you log in — the server only, without a window">
            <Toggle label="Start at login" checked={settings.launchAtLogin} onChange={(launchAtLogin) => void update({ launchAtLogin })} />
          </Row>

          <Row title="Phone access in the local network" hint="Lets your phone reach this computer. Off: only this computer can.">
            <Toggle
              label="Phone access in the local network"
              checked={lan}
              onChange={(v) => setLanPending(v === settings.lanAccess ? null : v)}
            />
          </Row>
          {lanPending !== null && (
            <div className="mb-2 rounded-xl border border-accent/30 bg-accent/10 p-3" role="alert">
              <p className="text-[12.5px] leading-snug">
                {lanPending ? 'Phones on your network will be able to reach AgentDeck. ' : 'Only this computer will be able to reach AgentDeck. '}
                The server restarts to apply this — running terminals keep going in tmux.
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    const next = lanPending;
                    setLanPending(null);
                    void update({ lanAccess: next });
                  }}
                  className="press flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 text-[13px] font-semibold text-white disabled:opacity-45"
                >
                  Apply and restart
                </button>
                <button
                  type="button"
                  onClick={() => setLanPending(null)}
                  className="press h-9 rounded-xl border border-line bg-white/[0.06] px-3.5 text-[13px] font-medium hover:bg-white/[0.1]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-2 border-t border-line pt-3">
        <p className="mb-2 text-[14px] font-medium">Server</p>
        {!summary ? (
          <div className="skeleton h-12" aria-label="Loading server status" />
        ) : (
          <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">
            <span aria-hidden className={clsx('h-2 w-2 shrink-0 rounded-full', TONE_DOT[summary.tone])} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{summary.label}</span>
              {summary.detail && <span className="block truncate font-mono text-[11px] text-dim">{summary.detail}</span>}
            </span>
            {busy && busy !== 'settings' && <Loader2 size={15} className="shrink-0 animate-spin text-dim" aria-label="Working…" />}
          </div>
        )}

        {actions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {actions.map((spec) => {
              const isArmed = armed === spec.action;
              return (
                <button
                  key={spec.action}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => runAction(spec.action)}
                  className={clsx(
                    'press h-9 rounded-xl border px-3.5 text-[13px] font-medium disabled:opacity-45',
                    isArmed
                      ? 'border-danger bg-danger text-white'
                      : spec.danger
                        ? 'border-danger/35 bg-danger/10 text-danger hover:bg-danger/15'
                        : 'border-line bg-white/[0.06] hover:bg-white/[0.1]',
                  )}
                >
                  {isArmed ? `Tap again to ${spec.label.toLowerCase()}` : spec.label}
                </button>
              );
            })}
          </div>
        )}
        {status && !status.controllable && (
          <p className="mt-2 text-[12px] leading-snug text-dim">
            This server is run by something else (a checkout or a terminal) — the app only connects to it and cannot start or stop it.
          </p>
        )}
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-dim">
          Terminals run in tmux: they keep running when the server stops or restarts, and are back when it is up again.
        </p>
      </div>
    </section>
  );
}
