import path from 'node:path';

export interface XdgPaths {
  configHome: string;
  dataHome: string;
  stateHome: string;
}

/** XDG base dirs — an unset or relative variable falls back to the default, per spec. */
export function xdgPaths(env: NodeJS.ProcessEnv, home: string): XdgPaths {
  const pick = (value: string | undefined, fallback: string): string =>
    value && path.isAbsolute(value) ? value : path.join(home, fallback);
  return {
    configHome: pick(env.XDG_CONFIG_HOME, '.config'),
    dataHome: pick(env.XDG_DATA_HOME, '.local/share'),
    stateHome: pick(env.XDG_STATE_HOME, '.local/state'),
  };
}

export interface DesktopPaths {
  /** Electron userData: window state, settings, the fixed browser partition. */
  userData: string;
  /** stdout/stderr of a server the app started itself. */
  serverLog: string;
  desktopLog: string;
  /** Which detached server (pid) this app started. */
  detachedMarker: string;
  settings: string;
  state: string;
  windowState: string;
  autostartFile: string;
  /** `<dataHome>/agentdeck/runtime` — stable copies of the server bundle. */
  runtimeDir: string;
}

export function desktopPaths(xdg: XdgPaths, env: NodeJS.ProcessEnv): DesktopPaths {
  const userData = env.AGENTDECK_DESKTOP_USER_DATA || path.join(xdg.configHome, 'agentdeck-desktop');
  return {
    userData,
    serverLog: path.join(xdg.stateHome, 'agentdeck', 'server.log'),
    desktopLog: path.join(xdg.stateHome, 'agentdeck', 'desktop.log'),
    detachedMarker: path.join(userData, 'detached.json'),
    settings: path.join(userData, 'settings.json'),
    state: path.join(userData, 'state.json'),
    windowState: path.join(userData, 'window-state.json'),
    autostartFile: path.join(xdg.configHome, 'autostart', 'agentdeck.desktop'),
    runtimeDir: path.join(xdg.dataHome, 'agentdeck', 'runtime'),
  };
}
