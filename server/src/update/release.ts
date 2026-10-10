/**
 * Release lookup for server self-update: the latest GitHub release of the
 * repo this checkout was cloned from, via the `gh` CLI (works for private
 * repos with the login that is already on the machine). A packaged server has
 * no checkout: it asks `gh` about the public repo and, without a usable `gh`,
 * the unauthenticated GitHub API.
 */
import { execa } from 'execa';

/** The repo releases are published to (a packaged server has no checkout to read it from). */
export const RELEASE_REPO = 'Ninjalama1337/agentdeck';

export interface ReleaseInfo {
  /** Git tag, e.g. `v1.2.3`. */
  tag: string;
  /** Tag without the `v`. */
  version: string;
  url?: string;
  publishedAt?: string;
  notes?: string;
}

/** `v1.2.3`, `1.2.3`, `1.2.3-4-gabc1234` → [1, 2, 3]; undefined when not a version. */
export function parseVersion(input: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `latest` is a release ahead of `current`. A checkout that sits
 * past a release (`1.2.3-4-gabc1234`) counts as that release — it already
 * contains it, so only a higher release number is an update.
 */
export function isNewerRelease(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

export type FetchRelease = (repoRoot: string) => Promise<ReleaseInfo | null>;

interface GhRelease {
  tagName?: string;
  url?: string;
  publishedAt?: string;
  body?: string;
}

/** The release in a GitHub API / `gh --json` payload, or throws when the tag is not a version. */
function releaseFrom(tag: string, url: string | undefined, publishedAt: string | undefined, body: string | undefined): ReleaseInfo {
  if (!parseVersion(tag)) throw new Error(`Latest release has an unexpected tag: ${tag || '(none)'}`);
  return {
    tag,
    version: tag.replace(/^v/, ''),
    ...(url ? { url } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(body ? { notes: body.slice(0, 4000) } : {}),
  };
}

/** `gh release view`, optionally for an explicit repo (`-R`) instead of the one in `repoRoot`. */
async function ghLatestRelease(repoRoot: string, repo?: string): Promise<ReleaseInfo | null> {
  let res;
  try {
    res = await execa(
      'gh',
      ['release', 'view', ...(repo ? ['-R', repo] : []), '--json', 'tagName,url,publishedAt,body'],
      { cwd: repoRoot, reject: false, timeout: 30_000, stdin: 'ignore' },
    );
  } catch {
    throw new Error('GitHub CLI (gh) is not installed on the server.');
  }
  if (res.exitCode !== 0) {
    const stderr = String(res.stderr || '').trim();
    if (/release not found/i.test(stderr)) return null;
    if (/gh auth login|not logged in|authentication/i.test(stderr)) {
      throw new Error('GitHub CLI is not logged in on the server — run `gh auth login` there.');
    }
    throw new Error(`Could not read the latest release: ${stderr.slice(0, 300) || 'gh failed'}`);
  }
  let parsed: GhRelease;
  try {
    parsed = JSON.parse(String(res.stdout)) as GhRelease;
  } catch {
    throw new Error('GitHub CLI returned unexpected output.');
  }
  return releaseFrom(parsed.tagName ?? '', parsed.url, parsed.publishedAt, parsed.body);
}

/**
 * Latest published release, or null when the repo has none yet. Throws an
 * Error whose message is fit for the app (gh missing, not logged in, offline).
 */
export const fetchLatestRelease: FetchRelease = (repoRoot) => ghLatestRelease(repoRoot);

type HttpFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

interface ApiRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
}

/**
 * Latest release from the public GitHub API, no login needed. A repo that is
 * private or has no release answers 404 → null.
 */
export async function fetchLatestReleasePublic(
  repo = RELEASE_REPO,
  httpFetch: HttpFetch = fetch as unknown as HttpFetch,
): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Awaited<ReturnType<HttpFetch>>;
  let parsed: ApiRelease | undefined;
  try {
    res = await httpFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentdeck-server' },
      signal: controller.signal,
    });
    if (res.ok) parsed = (await res.json()) as ApiRelease;
  } catch {
    throw new Error('Could not reach GitHub to look for a newer release.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (!parsed) throw new Error(`GitHub answered ${res.status} when asked for the latest release.`);
  return releaseFrom(parsed.tag_name ?? '', parsed.html_url, parsed.published_at, parsed.body);
}

export interface PackagedFetchers {
  /** `gh release view -R <repo>` */
  gh?: (repoRoot: string, repo: string) => Promise<ReleaseInfo | null>;
  publicApi?: (repo: string) => Promise<ReleaseInfo | null>;
}

/**
 * Release lookup of a packaged server (no checkout, `gh` often absent or not
 * signed in): `gh` for the public repo when it works, else the public API.
 */
export function packagedReleaseFetcher(fetchers: PackagedFetchers = {}): FetchRelease {
  const gh = fetchers.gh ?? ghLatestRelease;
  const publicApi = fetchers.publicApi ?? ((repo: string) => fetchLatestReleasePublic(repo));
  return async (repoRoot) => {
    try {
      return await gh(repoRoot, RELEASE_REPO);
    } catch {
      return publicApi(RELEASE_REPO);
    }
  };
}

export const fetchLatestReleasePackaged: FetchRelease = packagedReleaseFetcher();
