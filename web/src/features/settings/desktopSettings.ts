/**
 * Logic behind Settings → Desktop app, without React: what the shell's bridge
 * reports, which service actions make sense, and a controller that keeps the
 * bridge's state and turns every failed call into a message (never an
 * unhandled rejection).
 */
import type {
  DesktopBridge,
  DesktopCloseAction,
  DesktopServerStatus,
  DesktopServiceAction,
  DesktopSettings,
} from '@agentdeck/shared';

export const CLOSE_ACTIONS: { value: DesktopCloseAction; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask', hint: 'Asks every time whether AgentDeck keeps running' },
  { value: 'background', label: 'Keep running', hint: 'The server keeps running without a window' },
  { value: 'stop', label: 'Stop and quit', hint: 'Stops the server as well — terminals keep running in tmux' },
];

export function closeActionHint(action: DesktopCloseAction): string {
  return CLOSE_ACTIONS.find((o) => o.value === action)?.hint ?? '';
}

/** What the Settings card says about the server: one line and a tone. */
export interface ServerSummary {
  label: string;
  tone: 'ok' | 'warn' | 'dim';
  /** Version and address, as far as known. */
  detail: string;
}

export function summarizeServer(status: DesktopServerStatus): ServerSummary {
  const detail = [status.version ? `v${status.version}` : null, status.host && status.port ? `${status.host}:${status.port}` : null]
    .filter(Boolean)
    .join(' · ');
  switch (status.mode) {
    case 'service':
      return { label: status.reachable ? 'Background service · running' : 'Background service · not responding', tone: status.reachable ? 'ok' : 'warn', detail };
    case 'detached':
      return { label: status.reachable ? 'Started by this app · running' : 'Started by this app · not responding', tone: status.reachable ? 'ok' : 'warn', detail };
    case 'external':
      return { label: 'Run by something else', tone: status.reachable ? 'ok' : 'warn', detail };
    case 'stopped':
      return { label: 'Not running', tone: 'warn', detail };
  }
}

export interface ServiceActionSpec {
  action: DesktopServiceAction;
  label: string;
  /** Completes "Could not …" in the error message. */
  verb: string;
  /** Asked before it runs (tap twice): it takes the server down. */
  confirm: boolean;
  danger?: boolean;
}

const ACTION_SPECS: Record<DesktopServiceAction, ServiceActionSpec> = {
  start: { action: 'start', label: 'Start', verb: 'start the server', confirm: false },
  restart: { action: 'restart', label: 'Restart', verb: 'restart the server', confirm: false },
  stop: { action: 'stop', label: 'Stop', verb: 'stop the server', confirm: true, danger: true },
  install: { action: 'install', label: 'Set up as background service', verb: 'set up the background service', confirm: false },
  uninstall: { action: 'uninstall', label: 'Remove background service', verb: 'remove the background service', confirm: true, danger: true },
};

/**
 * The actions the Settings card offers for this status. A server the app may
 * not control (run by a checkout, say) offers none; a service can only be
 * installed or removed where systemd is usable.
 */
export function serviceActions(status: DesktopServerStatus | null): ServiceActionSpec[] {
  if (!status || !status.controllable) return [];
  const out: ServiceActionSpec[] = status.reachable ? [ACTION_SPECS.restart, ACTION_SPECS.stop] : [ACTION_SPECS.start];
  const service = status.service;
  if (service?.systemd) out.push(service.installed ? ACTION_SPECS.uninstall : ACTION_SPECS.install);
  return out;
}

/** Two taps for the actions that take the server down: the first arms, the second runs. */
export function confirmStep(
  armed: DesktopServiceAction | null,
  tapped: DesktopServiceAction,
): { run: boolean; armed: DesktopServiceAction | null } {
  if (!ACTION_SPECS[tapped].confirm) return { run: true, armed: null };
  return armed === tapped ? { run: true, armed: null } : { run: false, armed: tapped };
}

/** Text of a failed bridge call — Electron prefixes IPC errors with "Error invoking remote method …". */
export function bridgeErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim() || 'The desktop app did not answer';
}

export interface DesktopState {
  settings: DesktopSettings | null;
  status: DesktopServerStatus | null;
  /** A call that is running right now: a service action, or 'settings'. */
  busy: DesktopServiceAction | 'settings' | null;
}

export interface DesktopController {
  getState(): DesktopState;
  subscribe(listener: () => void): () => void;
  /** Changes settings; resolves false (and reports) when the shell refused. */
  update(patch: Partial<DesktopSettings>): Promise<boolean>;
  /** Runs a service action; resolves false (and reports) when it failed. */
  run(action: DesktopServiceAction): Promise<boolean>;
  dispose(): void;
}

/**
 * Loads settings and status from the bridge, follows its status events, and
 * routes every failure to `onError`.
 */
export function createDesktopController(bridge: DesktopBridge, onError: (message: string) => void): DesktopController {
  let state: DesktopState = { settings: null, status: null, busy: null };
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<DesktopState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const report = (what: string, err: unknown) => onError(`${what}: ${bridgeErrorMessage(err)}`);

  let unsubscribeStatus: () => void = () => undefined;
  try {
    unsubscribeStatus = bridge.onServerStatus((status) => set({ status }));
  } catch (err) {
    report('Could not follow the server status', err);
  }

  const call = <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return fn();
    } catch (err) {
      return Promise.reject(err);
    }
  };
  void call(() => bridge.getSettings()).then(
    (settings) => set({ settings }),
    (err: unknown) => report('Could not read the desktop settings', err),
  );
  void call(() => bridge.getServerStatus()).then(
    (status) => set({ status }),
    (err: unknown) => report('Could not read the server status', err),
  );

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(patch) {
      set({ busy: 'settings' });
      try {
        set({ settings: await call(() => bridge.setSettings(patch)) });
        return true;
      } catch (err) {
        report('Could not change the setting', err);
        return false;
      } finally {
        set({ busy: null });
      }
    },
    async run(action) {
      set({ busy: action });
      try {
        set({ status: await call(() => bridge.serviceAction(action)) });
        return true;
      } catch (err) {
        report(`Could not ${ACTION_SPECS[action].verb}`, err);
        return false;
      } finally {
        set({ busy: null });
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
      try {
        unsubscribeStatus();
      } catch {
        /* the shell is gone */
      }
    },
  };
}
