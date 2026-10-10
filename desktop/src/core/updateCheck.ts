import { compareVersions, type ReleaseInfo } from './versions';

export const RELEASES_API = 'https://api.github.com/repos/Ninjalama1337/agentdeck/releases/latest';
export const RELEASES_PAGE = 'https://github.com/Ninjalama1337/agentdeck/releases/latest';

type ReleaseFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Latest GitHub release (public API, no login), or null when it cannot be read. */
export async function fetchLatestRelease(fetch: ReleaseFetch, timeoutMs = 8000): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'AgentDeck-Desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown } | null;
    if (!body || typeof body.tag_name !== 'string' || body.draft === true || body.prerelease === true) return null;
    const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : RELEASES_PAGE;
    return { version: body.tag_name.replace(/^v/, ''), url };
  } catch {
    return null;
  }
}

/** A release the user should hear about: newer than this app and not waved off before. */
export function isUpdateWorthNoticing(current: string, latest: ReleaseInfo, ignored: string | undefined): boolean {
  const cmp = compareVersions(latest.version, current);
  return cmp !== null && cmp > 0 && latest.version !== ignored;
}
