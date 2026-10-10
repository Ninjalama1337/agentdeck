/**
 * Runs in every page of the window before the page's own scripts (sandboxed,
 * context-isolated). On the server's own origin it
 *   1. makes sure this device is paired (writes the login into localStorage
 *      before the web app reads it), and
 *   2. exposes `window.agentdeckDesktop` (DesktopBridge).
 * Anywhere else (loading page) it does nothing.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type InitInfo } from './channels';
import type {
  DesktopBridge,
  DesktopServerStatus,
  DesktopServiceAction,
  DesktopSettings,
} from './core/contract';
import type { PairOutcome } from './core/pairing';
import {
  activeIsLocal,
  applyPairing,
  LEGACY_TOKEN_KEY,
  planPairing,
  SERVERS_KEY,
  type StorageSnapshot,
} from './core/storagePairing';

function snapshot(): StorageSnapshot {
  try {
    return { servers: localStorage.getItem(SERVERS_KEY), legacyToken: localStorage.getItem(LEGACY_TOKEN_KEY) };
  } catch {
    return { servers: null, legacyToken: null };
  }
}

function store(servers: string): void {
  try {
    localStorage.setItem(SERVERS_KEY, servers);
  } catch {
    /* storage unavailable — the page falls back to its pairing screen */
  }
}

/** `Error invoking remote method 'x': Error: message` → `message`. */
function cleanError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  return new Error(text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    throw cleanError(err);
  }) as Promise<T>;
}

function ensurePaired(origin: string): void {
  const snap = snapshot();
  if (planPairing(snap, origin).action !== 'pair') return;
  const outcome = ipcRenderer.sendSync(CH.pairSync) as PairOutcome | null;
  if (outcome?.ok) store(applyPairing(snap, origin, outcome));
}

/** The server turned the saved login down: get a new one and reload. */
function repairOnUnauthorized(origin: string): void {
  let busy = false;
  window.addEventListener('agentdeck:unauthorized', () => {
    if (busy) return;
    busy = true;
    // Let the web app's own handler run first (it clears the dead token).
    setTimeout(() => {
      if (!activeIsLocal(snapshot(), origin)) {
        busy = false;
        return;
      }
      void (ipcRenderer.invoke(CH.pairAgain) as Promise<PairOutcome | null>)
        .then((outcome) => {
          if (!outcome?.ok) return;
          store(applyPairing(snapshot(), origin, outcome));
          location.reload();
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, 0);
  });
}

function exposeBridge(init: InitInfo): void {
  const bridge: DesktopBridge = {
    isDesktop: true,
    platform: init.platform,
    appVersion: init.appVersion,
    getSettings: () => call<DesktopSettings>(CH.getSettings),
    setSettings: (patch) => call<DesktopSettings>(CH.setSettings, patch),
    getServerStatus: () => call<DesktopServerStatus>(CH.getServerStatus),
    serviceAction: (action: DesktopServiceAction) => call<DesktopServerStatus>(CH.serviceAction, action),
    quit: (options) => call<void>(CH.quit, options ?? {}),
    onServerStatus(listener) {
      const handler = (_event: unknown, status: DesktopServerStatus): void => listener(status);
      ipcRenderer.on(CH.serverStatus, handler);
      return () => {
        ipcRenderer.removeListener(CH.serverStatus, handler);
      };
    },
  };
  contextBridge.exposeInMainWorld('agentdeckDesktop', bridge);
}

const init = ipcRenderer.sendSync(CH.init) as InitInfo | null;
if (init && window.location.origin === init.origin) {
  ensurePaired(init.origin);
  repairOnUnauthorized(init.origin);
  exposeBridge(init);
}
