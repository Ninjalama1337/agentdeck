/**
 * Desktop app contract — shared between the server's `agentdeck-server` CLI,
 * the Electron shell (desktop/) and the web UI. Types only.
 *
 * Moving parts:
 * - `agentdeck-server` (the daemon + its CLI) runs the server, optionally as a
 *   systemd user service, and answers `info --json` / `service status --json`.
 * - the desktop shell is a window on that server (it holds no state of its own)
 *   and exposes `DesktopBridge` to the web UI as `window.agentdeckDesktop`.
 */

/** Name of the systemd user unit managed by `agentdeck-server service …`. */
export const DESKTOP_SERVICE_UNIT = 'agentdeck.service';

/** First line of every unit written by the CLI — units without it are not ours. */
export const SERVICE_UNIT_MARKER = '# Managed by agentdeck-server';

/** `agentdeck-server info --json` */
export interface ServerCliInfo {
  /** Version of this server build (`1.2.3`, or `1.2.3-4-gabc1234` in a checkout). */
  version: string;
  /** True when running from a packaged bundle (no git checkout, version.json present). */
  packaged: boolean;
  /** Resolved data dir (config + env applied). */
  dataDir: string;
  configPath: string;
  /** Bind address and port as the server resolves them (config + env). */
  host: string;
  port: number;
  /** File holding the current 6-digit pairing code. */
  pairingCodeFile: string;
  /** File the running server writes its pid to (removed on clean exit). */
  pidFile: string;
  /** Built web app served by this build, if found. */
  webDist?: string;
}

/** `agentdeck-server service status --json` */
export interface ServiceCliStatus {
  /** `systemctl --user` is usable on this machine. */
  systemd: boolean;
  /** The unit file exists. */
  installed: boolean;
  /** The unit file was written by the CLI (carries SERVICE_UNIT_MARKER). */
  managed: boolean;
  /** Unit starts at login. */
  enabled: boolean;
  /** Unit is running right now. */
  active: boolean;
  mainPid?: number;
  unitPath: string;
  /** Unit binds to all interfaces (phone access in the LAN) instead of loopback. */
  lan: boolean;
  /** Version of the runtime copy the unit starts, if it is one of ours. */
  runtimeVersion?: string;
}

/** What closing the desktop window does. */
export type DesktopCloseAction = 'ask' | 'background' | 'stop';

export interface DesktopSettings {
  /** `ask` shows the "keep running / stop" dialog on every close. */
  closeAction: DesktopCloseAction;
  /** Server reachable from the LAN (phone) — false = loopback only. Applies via service reinstall + restart. */
  lanAccess: boolean;
  /** Start the desktop app (to the background service state, window hidden) at login. */
  launchAtLogin: boolean;
}

/** How the desktop shell reaches / runs the server right now. */
export type DesktopServerMode =
  /** A systemd user unit runs it. */
  | 'service'
  /** The app started it detached (no systemd, or the user declined the service). */
  | 'detached'
  /** Something else runs it (checkout, manual start) — the app only connects. */
  | 'external'
  /** Nothing is listening. */
  | 'stopped';

export interface DesktopServerStatus {
  mode: DesktopServerMode;
  reachable: boolean;
  version?: string;
  host: string;
  port: number;
  /** The app may stop/restart this server (service or detached, not external). */
  controllable: boolean;
  service: ServiceCliStatus | null;
}

export type DesktopServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart';

/** `window.agentdeckDesktop` — present only inside the desktop shell. */
export interface DesktopBridge {
  readonly isDesktop: true;
  /** `process.platform` of the shell (`linux`). */
  readonly platform: string;
  /** Version of the desktop app. */
  readonly appVersion: string;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  getServerStatus(): Promise<DesktopServerStatus>;
  serviceAction(action: DesktopServiceAction): Promise<DesktopServerStatus>;
  /** Quit the app; `stopService` also stops the server (terminals keep running in tmux). */
  quit(options?: { stopService?: boolean }): Promise<void>;
  /** Subscribe to status changes; returns the unsubscribe function. */
  onServerStatus(listener: (status: DesktopServerStatus) => void): () => void;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeAction: 'ask',
  lanAccess: false,
  launchAtLogin: false,
};
