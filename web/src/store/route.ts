/**
 * Hash router and the "where was I" memory. Pure — no store, no DOM — so the
 * rules for restoring a screen after a restart are testable on their own.
 */

export type Route =
  | { name: 'home' }
  | { name: 'chat' }
  | { name: 'code' }
  | { name: 'files' }
  | { name: 'git' }
  | { name: 'settings' }
  | { name: 'team'; runId: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (h === 'chat') return { name: 'chat' };
  if (h === 'code') return { name: 'code' };
  if (h === 'files') return { name: 'files' };
  if (h === 'git' || h === 'github') return { name: 'git' };
  if (h === 'settings') return { name: 'settings' };
  if (h.startsWith('team/')) return { name: 'team', runId: decodeRunId(h.slice('team/'.length)) };
  return { name: 'home' };
}

/** Inverse of the encodeURIComponent in routeToHash; an id that is not valid percent-encoding stays as written. */
function decodeRunId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'team':
      return `#/team/${encodeURIComponent(route.runId)}`;
    default:
      return `#/${route.name}`;
  }
}

const SCREEN_SLUGS = ['chat', 'code', 'files', 'git', 'github', 'settings'];

/** True for a hash that names a screen other than home — parseHash maps anything unknown to home, which must not pass as "remembered". */
export function isScreenHash(hash: string | null | undefined): hash is string {
  if (!hash) return false;
  const h = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (h.startsWith('team/')) return h.length > 'team/'.length;
  return SCREEN_SLUGS.includes(h);
}

/**
 * The hash the app opens on. A hash in the URL always wins (deep link, reload);
 * without one the screen last used on this server comes back, else home.
 */
export function startHash(current: string, stored: string | null): string {
  if (current !== '' && current !== '#') return current;
  return isScreenHash(stored) ? stored : '#/';
}

/** What the data must contain for a remembered screen to still make sense. */
export interface RouteFacts {
  /** Ids of the team runs the server knows. */
  teamRunIds: readonly string[];
}

/** A team run that is gone falls back to the chat list — never to a screen that waits forever. */
export function validRoute(route: Route, facts: RouteFacts): Route {
  if (route.name === 'team' && !facts.teamRunIds.includes(route.runId)) return { name: 'chat' };
  return route;
}

/** The remembered chat session, if it still exists in the loaded sessions. */
export function validSessionId(stored: string | null, sessionIds: readonly string[]): string | null {
  return stored && sessionIds.includes(stored) ? stored : null;
}
