/**
 * The Android APK is distributed straight from the public GitHub release — no
 * server hosts the binary anymore. This reads the latest release and hands out
 * the direct asset URL; the update banner (inside the native shell) and the
 * "Android app" cards use it. Comparing against the version this build carries
 * (`__APK_VERSION__`) tells whether an update is available.
 */
import { compareVersions } from './version';

/** Repo releases are published to (injected at build time, see vite.config.ts). */
export const RELEASE_REPO =
  typeof __RELEASE_REPO__ === 'string' && __RELEASE_REPO__ ? __RELEASE_REPO__ : 'Ninjalama1337/agentdeck';

/** Asset name android.yml attaches to every release. */
export const APK_ASSET_NAME = 'app-debug.apk';

export interface ApkRelease {
  /** Release version without the leading `v`. */
  version: string;
  tag: string;
  /** Direct GitHub download URL of the APK asset. */
  url: string;
  size?: number;
  publishedAt?: string;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function apkAsset(assets: GithubAsset[] | undefined): GithubAsset | undefined {
  return assets?.find((a) => a.name === APK_ASSET_NAME);
}

/** The asset URL, or GitHub's stable `releases/latest/download` alias as fallback. */
function assetUrl(repo: string, asset: GithubAsset | undefined): string {
  const url = asset?.browser_download_url;
  if (typeof url === 'string' && url.startsWith('https://github.com/')) return url;
  return `https://github.com/${repo}/releases/latest/download/${APK_ASSET_NAME}`;
}

/** Parses `GET /repos/{repo}/releases/latest`; null for a malformed, draft or pre-release payload. */
export function parseLatestRelease(payload: unknown, repo = RELEASE_REPO): ApkRelease | null {
  const rel = payload as GithubRelease | null;
  if (!rel || typeof rel.tag_name !== 'string' || rel.draft === true || rel.prerelease === true) return null;
  const tag = rel.tag_name;
  const version = tag.replace(/^v/, '');
  if (!/^\d/.test(version)) return null;
  const assets = Array.isArray(rel.assets) ? (rel.assets as GithubAsset[]) : undefined;
  const asset = apkAsset(assets);
  const size = typeof asset?.size === 'number' ? asset.size : undefined;
  return {
    version,
    tag,
    url: assetUrl(repo, asset),
    ...(size !== undefined ? { size } : {}),
    ...(typeof rel.published_at === 'string' ? { publishedAt: rel.published_at } : {}),
  };
}

/** Latest public release, or null when the repo/release is unavailable or the device is offline. */
export async function fetchLatestApkRelease(
  opts: { repo?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ApkRelease | null> {
  const repo = opts.repo ?? RELEASE_REPO;
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return null;
    return parseLatestRelease(await res.json(), repo);
  } catch {
    return null;
  }
}

/**
 * Version the update check compares against: what Android has installed when
 * it is known and newer than the bundle's constant — right after an APK
 * update the service worker can still serve the previous bundle, whose
 * constant would offer the update just installed.
 */
export function runningApkVersion(bundled: string, installed: string | null): string {
  if (!installed || !/^\d+\.\d+\.\d+/.test(installed)) return bundled;
  return compareVersions(bundled, installed) < 0 ? installed : bundled;
}

/** True when the release is newer than the version this build carries. */
export function apkUpdateAvailable(current: string, release: ApkRelease | null): boolean {
  return release !== null && compareVersions(current, release.version) < 0;
}
