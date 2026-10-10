/**
 * Pairing as the web app stores it (web/src/api/servers.ts): one JSON value in
 * localStorage holding the saved servers, exactly one of them active. Pure
 * functions over the raw strings, so they run in the preload and in tests alike.
 */

export const SERVERS_KEY = 'agentdeck:servers';
export const LEGACY_TOKEN_KEY = 'agentdeck:token';

export interface StoredProfile {
  id: string;
  name: string;
  /** '' = the server that serves the page. */
  base: string;
  token: string | null;
}

export interface StoredServers {
  servers: StoredProfile[];
  activeId: string;
}

/** The raw localStorage values pairing cares about. */
export interface StorageSnapshot {
  servers: string | null;
  legacyToken: string | null;
}

const DEFAULT_ID = 'default';

function isProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    p.id !== '' &&
    typeof p.name === 'string' &&
    typeof p.base === 'string' &&
    (p.token === null || typeof p.token === 'string')
  );
}

/** Same validation as the web app's parseState — a state it would reject counts as absent. */
export function parseServers(raw: string | null): StoredServers | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { servers?: unknown; activeId?: unknown };
    if (!Array.isArray(data.servers)) return null;
    const servers = data.servers.filter(isProfile);
    if (servers.length === 0) return null;
    const activeId =
      typeof data.activeId === 'string' && servers.some((s) => s.id === data.activeId)
        ? data.activeId
        : (servers[0] as StoredProfile).id;
    return { servers, activeId };
  } catch {
    return null;
  }
}

function trimSlashes(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** The profile talks to the server this window is on: same-origin ('') or its explicit address. */
export function isLocalBase(base: string, origin: string): boolean {
  const clean = trimSlashes(base);
  return clean === '' || clean === origin;
}

export type PairingPlan = { action: 'none' } | { action: 'pair' };

/**
 * Does the window need a login for its own server? Only the profile the web app
 * is on counts: someone who switched to another saved server keeps that one.
 */
export function planPairing(storage: StorageSnapshot, origin: string): PairingPlan {
  const state = parseServers(storage.servers);
  if (!state) {
    // Nothing saved yet — the web app would migrate a legacy token on first load.
    return storage.legacyToken ? { action: 'none' } : { action: 'pair' };
  }
  const active = state.servers.find((s) => s.id === state.activeId) as StoredProfile;
  if (!isLocalBase(active.base, origin)) return { action: 'none' };
  return active.token ? { action: 'none' } : { action: 'pair' };
}

/** Is the login the window just lost one for its own server (not for another saved one)? */
export function activeIsLocal(storage: StorageSnapshot, origin: string): boolean {
  const state = parseServers(storage.servers);
  if (!state) return true;
  const active = state.servers.find((s) => s.id === state.activeId) as StoredProfile;
  return isLocalBase(active.base, origin);
}

/** New value of `agentdeck:servers` with the token filed under the window's own server. */
export function applyPairing(
  storage: StorageSnapshot,
  origin: string,
  login: { token: string; serverName: string },
): string {
  const state = parseServers(storage.servers);
  if (!state) {
    const fresh: StoredServers = {
      servers: [{ id: DEFAULT_ID, name: login.serverName, base: '', token: login.token }],
      activeId: DEFAULT_ID,
    };
    return JSON.stringify(fresh);
  }
  const servers = state.servers.map((s) =>
    s.id === state.activeId && isLocalBase(s.base, origin) ? { ...s, name: login.serverName, token: login.token } : s,
  );
  return JSON.stringify({ servers, activeId: state.activeId } satisfies StoredServers);
}

/** Bearer token of the window's own server, if it has one (used for activity counts on close). */
export function localToken(raw: string | null, origin: string): string | null {
  const state = parseServers(raw);
  if (!state) return null;
  const active = state.servers.find((s) => s.id === state.activeId) as StoredProfile;
  if (isLocalBase(active.base, origin) && active.token) return active.token;
  const local = state.servers.find((s) => isLocalBase(s.base, origin) && s.token);
  return local?.token ?? null;
}
