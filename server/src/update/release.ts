/**
 * Release lookup for server self-update: the latest GitHub release of the
 * repo this checkout was cloned from, via the `gh` CLI (works for private
 * repos with the login that is already on the machine).
 */
import { execa } from 'execa';

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

/**
 * Latest published release, or null when the repo has none yet. Throws an
 * Error whose message is fit for the app (gh missing, not logged in, offline).
 */
export const fetchLatestRelease: FetchRelease = async (repoRoot) => {
  let res;
  try {
    res = await execa('gh', ['release', 'view', '--json', 'tagName,url,publishedAt,body'], {
      cwd: repoRoot,
      reject: false,
      timeout: 30_000,
      stdin: 'ignore',
    });
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
  const tag = parsed.tagName ?? '';
  if (!parseVersion(tag)) throw new Error(`Latest release has an unexpected tag: ${tag || '(none)'}`);
  return {
    tag,
    version: tag.replace(/^v/, ''),
    ...(parsed.url ? { url: parsed.url } : {}),
    ...(parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}),
    ...(parsed.body ? { notes: parsed.body.slice(0, 4000) } : {}),
  };
};
