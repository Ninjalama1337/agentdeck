export type NavigationVerdict = 'allow' | 'external' | 'block';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Where a navigation may go. The window only ever shows the server's own origin;
 * a web link leaves for the system browser, everything else (file:, javascript:,
 * data: …) is refused.
 */
export function classifyNavigation(url: string, origin: string): NavigationVerdict {
  const target = parse(url);
  if (!target) return 'block';
  if (target.origin === origin) return 'allow';
  if (target.protocol === 'http:' || target.protocol === 'https:') return 'external';
  return 'block';
}

/** Only pages of the server's own origin may talk to the main process. */
export function isTrustedSender(frameUrl: string | undefined, origin: string): boolean {
  if (!frameUrl) return false;
  return parse(frameUrl)?.origin === origin;
}

/** Permissions the AgentDeck page may use (notifications, voice input, clipboard, fullscreen). */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function isPermissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && parse(requestingUrl)?.origin === origin;
}
