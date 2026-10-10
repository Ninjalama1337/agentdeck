/**
 * Saved servers: one profile per AgentDeck server this device knows — its
 * address and its login — with exactly one of them active. The rest of the
 * app keeps talking to "the" server through client.ts, which reads the
 * active profile from here.
 *
 * Switching the active profile is followed by an app reload (see appStore),
 * so in-memory state and per-server storage keys never mix two servers.
 */

export interface ServerProfile {
  id: string;
  /** Server name reported at pairing; '' until this profile was paired once. */
  name: string;
  /** API base URL; '' means same origin (the server that serves this page). */
  base: string;
  /** Device JWT; null while unpaired. */
  token: string | null;
}

interface ServersState {
  servers: ServerProfile[];
  activeId: string;
}

const SERVERS_KEY = 'agentdeck:servers';
/** Single-server storage from before profiles existed — migrated on first load. */
const LEGACY_TOKEN_KEY = 'agentdeck:token';
const LEGACY_SERVER_KEY = 'agentdeck:server';
/** The migrated/first profile; its per-server keys stay unsuffixed (see scopedKey). */
const DEFAULT_ID = 'default';

/** localStorage keys whose content belongs to one server (project ids, inbox, where the user left off). */
export const PER_SERVER_KEYS = [
  'agentdeck:project',
  'agentdeck:inbox',
  'agentdeck:inbox-seen',
  'agentdeck:inbox-cleared',
  'agentdeck:update-notified',
  /** Last screen (hash route), open chat session and terminal panes — restored on the next start. */
  'agentdeck:route',
  'agentdeck:session',
  'agentdeck:panes',
] as const;

export function cleanBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function isProfile(value: unknown): value is ServerProfile {
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

function parseState(raw: string | null): ServersState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { servers?: unknown; activeId?: unknown };
    if (!Array.isArray(data.servers)) return null;
    const servers = data.servers.filter(isProfile);
    if (servers.length === 0) return null;
    const activeId =
      typeof data.activeId === 'string' && servers.some((s) => s.id === data.activeId)
        ? data.activeId
        : (servers[0] as ServerProfile).id;
    return { servers, activeId };
  } catch {
    return null;
  }
}

let state: ServersState | null = null;

function save(next: ServersState): void {
  state = next;
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the in-memory copy still serves this page load */
  }
}

function load(): ServersState {
  if (state) return state;
  const stored = parseState(storageGet(SERVERS_KEY));
  if (stored) {
    state = stored;
    return stored;
  }
  // First run with profiles: carry the single server + login over unchanged.
  const migrated: ServersState = {
    servers: [
      {
        id: DEFAULT_ID,
        name: '',
        base: cleanBase(storageGet(LEGACY_SERVER_KEY) ?? ''),
        token: storageGet(LEGACY_TOKEN_KEY) || null,
      },
    ],
    activeId: DEFAULT_ID,
  };
  save(migrated);
  storageRemove(LEGACY_TOKEN_KEY);
  storageRemove(LEGACY_SERVER_KEY);
  return migrated;
}

function newId(servers: ServerProfile[]): string {
  if (!servers.some((s) => s.id === DEFAULT_ID)) return DEFAULT_ID;
  for (;;) {
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!servers.some((s) => s.id === id)) return id;
  }
}

/** A profile that was added but never paired — dropped once the user moves on. */
function isAbandoned(profile: ServerProfile): boolean {
  return profile.token === null && profile.name === '';
}

function clearScopedKeys(id: string): void {
  for (const key of PER_SERVER_KEYS) storageRemove(id === DEFAULT_ID ? key : `${key}@${id}`);
}

export function listServers(): ServerProfile[] {
  return load().servers.map((s) => ({ ...s }));
}

export function getActiveServer(): ServerProfile {
  const { servers, activeId } = load();
  return { ...(servers.find((s) => s.id === activeId) as ServerProfile) };
}

export function updateActiveServer(patch: Partial<Pick<ServerProfile, 'name' | 'base' | 'token'>>): void {
  const { servers, activeId } = load();
  const clean = patch.base === undefined ? patch : { ...patch, base: cleanBase(patch.base) };
  save({ servers: servers.map((s) => (s.id === activeId ? { ...s, ...clean } : s)), activeId });
}

export function findServerByBase(base: string): ServerProfile | undefined {
  const clean = cleanBase(base);
  const hit = load().servers.find((s) => s.base === clean);
  return hit ? { ...hit } : undefined;
}

/** Adds an unpaired profile and makes it the active one. */
export function addServer(base = ''): ServerProfile {
  const { servers } = load();
  const kept = servers.filter((s) => !isAbandoned(s));
  const profile: ServerProfile = { id: newId(kept), name: '', base: cleanBase(base), token: null };
  clearScopedKeys(profile.id);
  save({ servers: [...kept, profile], activeId: profile.id });
  return { ...profile };
}

/** Makes `id` the active profile; false when it does not exist. */
export function activateServer(id: string): boolean {
  const { servers } = load();
  if (!servers.some((s) => s.id === id)) return false;
  save({ servers: servers.filter((s) => s.id === id || !isAbandoned(s)), activeId: id });
  return true;
}

/**
 * Forgets a profile and its per-server data. Removing the active one activates
 * another saved server, or a fresh unpaired profile when none is left.
 */
export function removeServer(id: string): void {
  const { servers, activeId } = load();
  if (!servers.some((s) => s.id === id)) return;
  clearScopedKeys(id);
  const rest = servers.filter((s) => s.id !== id);
  if (rest.length === 0) {
    clearScopedKeys(DEFAULT_ID);
    save({ servers: [{ id: DEFAULT_ID, name: '', base: '', token: null }], activeId: DEFAULT_ID });
    return;
  }
  save({ servers: rest, activeId: activeId === id ? (rest[0] as ServerProfile).id : activeId });
}

/**
 * Storage key for data that belongs to the active server. The first profile
 * keeps the plain key, so a single-server install reads exactly what it wrote
 * before profiles existed.
 */
export function scopedKey(key: string): string {
  const { activeId } = load();
  return activeId === DEFAULT_ID ? key : `${key}@${activeId}`;
}
