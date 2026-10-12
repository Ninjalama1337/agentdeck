import { describe, expect, it } from 'vitest';
import { fetchActivity } from '../src/core/activity';
import { childEnv } from '../src/core/env';
import { desktopPaths, xdgPaths } from '../src/core/paths';
import { isVolatilePath, stageRuntime } from '../src/core/runtimeStage';
import { statusPageHtml, statusPageUrl } from '../src/core/statusPage';
import { fetchLatestRelease, isUpdateWorthNoticing } from '../src/core/updateCheck';
import { classifyNavigation, isPermissionAllowed, isTrustedSender } from '../src/core/urlPolicy';
import { compareVersions, parseVersion, runtimeNeedsUpdate } from '../src/core/versions';
import { MemFs } from './helpers/memFs';

const ORIGIN = 'http://127.0.0.1:4317';

describe('paths', () => {
  it('follows the XDG variables and falls back to the defaults', () => {
    expect(xdgPaths({}, '/home/me')).toEqual({ configHome: '/home/me/.config', dataHome: '/home/me/.local/share', stateHome: '/home/me/.local/state' });
    expect(xdgPaths({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '/s' }, '/home/me')).toEqual({
      configHome: '/c', dataHome: '/home/me/.local/share', stateHome: '/s',
    });
  });

  it('keeps the user data dir fixed and separate from the server config', () => {
    const p = desktopPaths(xdgPaths({}, '/home/me'), {});
    expect(p.userData).toBe('/home/me/.config/agentdeck-desktop');
    expect(p.settings).toBe('/home/me/.config/agentdeck-desktop/settings.json');
    expect(p.windowState).toBe('/home/me/.config/agentdeck-desktop/window-state.json');
    expect(p.serverLog).toBe('/home/me/.local/state/agentdeck/server.log');
    expect(p.autostartFile).toBe('/home/me/.config/autostart/agentdeck.desktop');
    expect(p.runtimeDir).toBe('/home/me/.local/share/agentdeck/runtime');
    expect(desktopPaths(xdgPaths({}, '/home/me'), { AGENTDECK_DESKTOP_USER_DATA: '/tmp/ud' }).userData).toBe('/tmp/ud');
  });
});

describe('childEnv', () => {
  it('drops Electron and AppImage variables', () => {
    const env = childEnv({ HOME: '/h', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', APPIMAGE: '/a.AppImage', APPDIR: '/tmp/.mount_x', ARGV0: 'x', OWD: '/o' });
    expect(env).toEqual({ HOME: '/h' });
  });

  it('removes the AppImage mount from path lists but keeps the rest', () => {
    const env = childEnv({
      APPDIR: '/tmp/.mount_x',
      PATH: '/tmp/.mount_x/usr/bin:/usr/bin:/bin',
      LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib',
      XDG_DATA_DIRS: '/tmp/.mount_x/usr/share:/usr/share',
    });
    expect(env).toEqual({ PATH: '/usr/bin:/bin', XDG_DATA_DIRS: '/usr/share' });
  });

  it('leaves path lists untouched outside an AppImage', () => {
    expect(childEnv({ PATH: '/usr/bin:/bin' })).toEqual({ PATH: '/usr/bin:/bin' });
  });
});

describe('runtime staging', () => {
  it('knows the AppImage mount', () => {
    expect(isVolatilePath('/tmp/.mount_AgentDXYZ/resources/server/bin/agentdeck-server', {})).toBe(true);
    expect(isVolatilePath('/run/user/1000/appimage/x/bin', { APPDIR: '/run/user/1000/appimage/x' })).toBe(true);
    expect(isVolatilePath('/opt/AgentDeck/resources/server/bin/agentdeck-server', {})).toBe(false);
    expect(isVolatilePath('/home/me/.local/share/agentdeck/runtime/1.0.0/bin/agentdeck-server', {})).toBe(false);
  });

  it('copies the bundle once into runtime/<version>', async () => {
    const fs = new MemFs({
      '/tmp/.mount_x/resources/server/bin/agentdeck-server': '#!/bin/sh',
      '/tmp/.mount_x/resources/server/version.json': '{}',
    });
    const options = { fs, bundleRoot: '/tmp/.mount_x/resources/server', version: '1.2.3', runtimeDir: '/data/agentdeck/runtime', pid: 1 };
    const bin = await stageRuntime(options);
    expect(bin).toBe('/data/agentdeck/runtime/1.2.3/bin/agentdeck-server');
    expect(await fs.exists('/data/agentdeck/runtime/1.2.3/version.json')).toBe(true);
    expect([...fs.files.keys()].some((f) => f.includes('.staging'))).toBe(false);
    // already there: not copied again
    fs.files.set('/data/agentdeck/runtime/1.2.3/marker', { data: 'keep' });
    expect(await stageRuntime(options)).toBe(bin);
    expect(await fs.exists('/data/agentdeck/runtime/1.2.3/marker')).toBe(true);
  });

  it('refuses a version that is not a plain version string', async () => {
    await expect(stageRuntime({ fs: new MemFs(), bundleRoot: '/b', version: '../etc', runtimeDir: '/r', pid: 1 })).rejects.toThrow(/Refusing/);
  });
});

describe('URL policy', () => {
  it('lets the server origin load and sends web links to the system browser', () => {
    expect(classifyNavigation(`${ORIGIN}/#/chats`, ORIGIN)).toBe('allow');
    expect(classifyNavigation('https://github.com/x', ORIGIN)).toBe('external');
    expect(classifyNavigation('http://127.0.0.1:9999/', ORIGIN)).toBe('external');
    expect(classifyNavigation('http://localhost:4317/', ORIGIN)).toBe('external');
  });

  it('blocks every other scheme', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x/', 'mailto:a@b', 'not a url', '']) {
      expect(classifyNavigation(url, ORIGIN)).toBe('block');
    }
  });

  it('answers only pages of the server origin over IPC', () => {
    expect(isTrustedSender(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isTrustedSender('https://evil.example/', ORIGIN)).toBe(false);
    expect(isTrustedSender('data:text/html,x', ORIGIN)).toBe(false);
    expect(isTrustedSender(undefined, ORIGIN)).toBe(false);
    expect(isTrustedSender('', ORIGIN)).toBe(false);
  });

  it('grants only the permissions the app needs, only to the server origin', () => {
    expect(isPermissionAllowed('notifications', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isPermissionAllowed('media', ORIGIN, ORIGIN)).toBe(true);
    expect(isPermissionAllowed('geolocation', `${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(isPermissionAllowed('notifications', 'https://evil.example/', ORIGIN)).toBe(false);
  });
});

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-4-gabc')).toEqual([1, 2, 3]);
    expect(parseVersion('dev')).toBeNull();
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('x', '1.0.0')).toBeNull();
  });

  it('updates the service runtime for newer or different builds, never for older ones', () => {
    expect(runtimeNeedsUpdate('2.0.0', '2.0.0')).toBe(false);
    expect(runtimeNeedsUpdate('2.0.1', '2.0.0')).toBe(true);
    expect(runtimeNeedsUpdate('2.0.0', '2.0.1')).toBe(false);
    expect(runtimeNeedsUpdate('2.0.0', '2.0.0-3-gabc1234')).toBe(true);
    expect(runtimeNeedsUpdate('2.0.0', 'weird')).toBe(true);
  });
});

describe('update check', () => {
  const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

  it('reads the latest release from the GitHub API', async () => {
    const release = await fetchLatestRelease(answer({ tag_name: 'v1.4.0', html_url: 'https://github.com/Ninjalama1337/agentdeck/releases/tag/v1.4.0' }));
    expect(release).toEqual({ version: '1.4.0', url: 'https://github.com/Ninjalama1337/agentdeck/releases/tag/v1.4.0' });
  });

  it('ignores drafts, prereleases, errors and foreign links', async () => {
    expect(await fetchLatestRelease(answer({ tag_name: 'v1.4.0', draft: true }))).toBeNull();
    expect(await fetchLatestRelease(answer({ tag_name: 'v1.4.0', prerelease: true }))).toBeNull();
    expect(await fetchLatestRelease(answer({}, false))).toBeNull();
    expect(await fetchLatestRelease(async () => { throw new Error('offline'); })).toBeNull();
    expect((await fetchLatestRelease(answer({ tag_name: 'v1.4.0', html_url: 'https://evil.example/' })))?.url).toBe(
      'https://github.com/Ninjalama1337/agentdeck/releases/latest',
    );
  });

  it('notices only a newer release that was not waved off', () => {
    const latest = { version: '1.4.0', url: 'u' };
    expect(isUpdateWorthNoticing('1.3.0', latest, undefined)).toBe(true);
    expect(isUpdateWorthNoticing('1.4.0', latest, undefined)).toBe(false);
    expect(isUpdateWorthNoticing('1.5.0', latest, undefined)).toBe(false);
    expect(isUpdateWorthNoticing('1.3.0', latest, '1.4.0')).toBe(false);
    expect(isUpdateWorthNoticing('dev', latest, undefined)).toBe(false);
  });
});

describe('fetchActivity', () => {
  const route = (map: Record<string, unknown>) => async (url: string, init?: { headers?: Record<string, string> }) => {
    const key = new URL(url).pathname;
    const body = map[key];
    return { ok: body !== undefined, status: body === undefined ? 401 : 200, json: async () => body, auth: init?.headers?.authorization };
  };

  it('counts running and queued sessions and all terminals', async () => {
    const seen: Array<string | undefined> = [];
    const f = route({ '/api/sessions': [{ status: 'running' }, { status: 'queued' }, { status: 'idle' }, { status: 'error' }], '/api/terminals': [{}, {}] });
    const result = await fetchActivity({
      baseUrl: ORIGIN,
      token: 'jwt',
      fetch: async (url, init) => {
        const r = await f(url, init);
        seen.push(r.auth);
        return r;
      },
    });
    expect(result).toEqual({ runs: 2, terminals: 2 });
    expect(seen).toEqual(['Bearer jwt', 'Bearer jwt']);
  });

  it('is null without a token, when the server refuses, or on garbage', async () => {
    expect(await fetchActivity({ baseUrl: ORIGIN, token: null, fetch: route({}) })).toBeNull();
    expect(await fetchActivity({ baseUrl: ORIGIN, token: 'x', fetch: route({ '/api/sessions': [] }) })).toBeNull();
    expect(await fetchActivity({ baseUrl: ORIGIN, token: 'x', fetch: route({ '/api/sessions': {}, '/api/terminals': [] }) })).toBeNull();
    expect(await fetchActivity({ baseUrl: ORIGIN, token: 'x', fetch: async () => { throw new Error('down'); } })).toBeNull();
  });
});

describe('status page', () => {
  it('escapes its text', () => {
    const html = statusPageHtml({ origin: ORIGIN, title: '<b>x</b>', detail: 'a & "b"' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &amp; &quot;b&quot;');
    expect(statusPageUrl({ origin: ORIGIN, title: 't' }).startsWith('data:text/html;charset=utf-8,')).toBe(true);
  });

  // A page that moves on by itself would follow a foreign program on the port just the same:
  // the main process loads the app once it has found an AgentDeck server.
  it('never navigates, runs no script and contacts nothing', () => {
    const html = statusPageHtml({ origin: ORIGIN, title: 'AgentDeck startet …' });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/location|fetch|XMLHttpRequest|WebSocket|http-equiv/i);
    expect(html).not.toContain(ORIGIN);
  });
});
