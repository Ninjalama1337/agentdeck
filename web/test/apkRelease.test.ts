import { describe, expect, it } from 'vitest';
import {
  apkUpdateAvailable,
  fetchLatestApkRelease,
  parseLatestRelease,
} from '../src/util/apkRelease';

const RELEASE = {
  tag_name: 'v1.4.0',
  published_at: '2026-10-13T04:39:15Z',
  assets: [
    { name: 'AgentDeck-1.4.0-linux-x86_64.AppImage', browser_download_url: 'https://github.com/o/r/releases/download/v1.4.0/AgentDeck-1.4.0-linux-x86_64.AppImage', size: 1 },
    { name: 'app-debug.apk', browser_download_url: 'https://github.com/o/r/releases/download/v1.4.0/app-debug.apk', size: 12345 },
  ],
};

describe('parseLatestRelease', () => {
  it('maps the tag and the app-debug.apk asset', () => {
    const release = parseLatestRelease(RELEASE, 'o/r');
    expect(release).toEqual({
      version: '1.4.0',
      tag: 'v1.4.0',
      url: 'https://github.com/o/r/releases/download/v1.4.0/app-debug.apk',
      size: 12345,
      publishedAt: '2026-10-13T04:39:15Z',
    });
  });

  it('falls back to the stable releases/latest/download URL when the asset is missing', () => {
    const release = parseLatestRelease({ tag_name: 'v1.4.0', assets: [] }, 'o/r');
    expect(release?.url).toBe('https://github.com/o/r/releases/latest/download/app-debug.apk');
  });

  it('ignores drafts, pre-releases, foreign asset links and non-version tags', () => {
    expect(parseLatestRelease({ tag_name: 'v1.4.0', draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v1.4.0', prerelease: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'nightly' })).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    const foreign = parseLatestRelease(
      { tag_name: 'v1.4.0', assets: [{ name: 'app-debug.apk', browser_download_url: 'https://evil.example/app-debug.apk' }] },
      'o/r',
    );
    expect(foreign?.url).toBe('https://github.com/o/r/releases/latest/download/app-debug.apk');
  });
});

describe('apkUpdateAvailable', () => {
  const release = { version: '1.4.0', tag: 'v1.4.0', url: 'u' };

  it('is true only when the release is newer than this build', () => {
    expect(apkUpdateAvailable('1.3.0', release)).toBe(true);
    expect(apkUpdateAvailable('1.4.0', release)).toBe(false);
    expect(apkUpdateAvailable('1.5.0', release)).toBe(false);
    expect(apkUpdateAvailable('0.0.0-web', release)).toBe(true);
  });

  it('is false without a release', () => {
    expect(apkUpdateAvailable('1.3.0', null)).toBe(false);
  });
});

describe('fetchLatestApkRelease', () => {
  it('reads the latest release from the GitHub API', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => RELEASE })) as unknown as typeof fetch;
    const release = await fetchLatestApkRelease({ repo: 'o/r', fetch: fetchImpl });
    expect(release?.version).toBe('1.4.0');
  });

  it('stays quiet on errors, 404 and offline', async () => {
    const notOk = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchLatestApkRelease({ repo: 'o/r', fetch: notOk })).toBeNull();
    const throws = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchLatestApkRelease({ repo: 'o/r', fetch: throws })).toBeNull();
  });
});
