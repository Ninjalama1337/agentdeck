import { describe, expect, it } from 'vitest';
import { isServerProcess, looksLikeServer, type ProcessProbe } from '../src/core/pidfile';

const PKG = '@agentdeck/server';
/** package.json names by path — a tiny stand-in for the file system. */
const names = (known: Record<string, string>) => (file: string) => known[file];

describe('looksLikeServer (ported from server/src/util/pidfile.ts)', () => {
  it('knows the bundle launcher, as program or run by a shell', () => {
    expect(looksLikeServer(['/opt/AgentDeck/resources/server/bin/agentdeck-server'])).toBe(true);
    expect(looksLikeServer(['/bin/sh', '/opt/AgentDeck/resources/server/bin/agentdeck-server'])).toBe(true);
    expect(looksLikeServer(['bash', 'agentdeck-server', 'service', 'status'])).toBe(true);
  });

  it('is not fooled by other programs that merely mention the name', () => {
    expect(looksLikeServer(['vim', 'agentdeck-server.md'])).toBe(false);
    expect(looksLikeServer(['vim', '/home/me/agentdeck-server'])).toBe(false);
    expect(looksLikeServer(['/usr/bin/less', '/var/log/agentdeck-server.log'])).toBe(false);
    expect(looksLikeServer(['/bin/sh', '-c', 'echo agentdeck-server'])).toBe(false);
    expect(looksLikeServer(['grep', '-r', 'agentdeck', '/home/me/agentdeck'])).toBe(false);
  });

  it('knows a bundle or checkout entry point whose package is the AgentDeck server', () => {
    const known = names({
      '/opt/AgentDeck/resources/server/app/server/package.json': PKG,
      '/home/me/agentdeck/server/package.json': PKG,
    });
    const node = '/opt/AgentDeck/resources/server/node/bin/node';
    expect(looksLikeServer([node, '/opt/AgentDeck/resources/server/app/server/dist/cli.js'], { packageName: known })).toBe(true);
    expect(looksLikeServer(['node', '/home/me/agentdeck/server/dist/index.js'], { packageName: known })).toBe(true);
    expect(looksLikeServer(['node', '--enable-source-maps', '/home/me/agentdeck/server/dist/index.js'], { packageName: known })).toBe(true);
    expect(looksLikeServer(['node', '/home/me/agentdeck/server/src/cli.ts'], { packageName: known })).toBe(true);
    expect(looksLikeServer(['tsx', 'watch', 'src/index.ts'], { cwd: '/home/me/agentdeck/server', packageName: known })).toBe(true); // dev run, relative
  });

  it('resolves a relative entry against the working directory', () => {
    const known = names({ '/home/me/agentdeck/server/package.json': PKG });
    expect(looksLikeServer(['node', 'dist/index.js'], { cwd: '/home/me/agentdeck/server', packageName: known })).toBe(true);
    expect(looksLikeServer(['node', 'server/dist/cli.js'], { cwd: '/home/me/agentdeck', packageName: known })).toBe(true);
    expect(looksLikeServer(['node', 'server/dist/cli.js'], { packageName: known })).toBe(false); // cwd unknown
    expect(looksLikeServer(['node', '../server/dist/cli.js'], { cwd: '/home/me/agentdeck/web', packageName: known })).toBe(true);
  });

  it('rejects any other project with a dist/cli.js, and a server/ dir of another package', () => {
    const known = names({ '/other/project/package.json': 'other', '/srv/app/server/package.json': 'some-other-server' });
    expect(looksLikeServer(['node', '/other/project/dist/cli.js'], { packageName: known })).toBe(false);
    expect(looksLikeServer(['node', '/anderes/projekt/dist/cli.js'], { packageName: known })).toBe(false);
    expect(looksLikeServer(['node', '/srv/app/server/dist/cli.js'], { packageName: known })).toBe(false);
    expect(looksLikeServer(['node', '/srv/app/server/dist/cli.js'], { packageName: () => undefined })).toBe(false);
  });

  it('ignores options and the program itself when looking for an entry point', () => {
    const known = names({ '/x/server/package.json': PKG });
    expect(looksLikeServer(['/x/server/dist/cli.js'], { packageName: known })).toBe(false); // argv[0] is the program, not a script
    expect(looksLikeServer(['node', '--require=/x/server/dist/cli.js'], { packageName: known })).toBe(false);
  });

  it('normalizes the path before matching', () => {
    const known = names({ '/x/server/package.json': PKG });
    expect(looksLikeServer(['node', '/x/other/../server/dist/cli.js'], { packageName: known })).toBe(true);
    expect(looksLikeServer(['node', '/x/server/dist/cli.js/../../../evil/dist/cli.js'], { packageName: known })).toBe(false);
  });
});

function probe(over: { alive?: boolean; cmdline?: ProcessProbe['cmdline']; cwd?: ProcessProbe['cwd']; packageName?: ProcessProbe['packageName'] }): ProcessProbe {
  return {
    alive: () => over.alive ?? true,
    cmdline: over.cmdline ?? (() => undefined),
    cwd: over.cwd ?? (() => '/'),
    packageName: over.packageName ?? (() => PKG),
  };
}

describe('isServerProcess', () => {
  it('a dead process is no server (stale pid)', () => {
    expect(isServerProcess(5, probe({ alive: false, cmdline: () => ['agentdeck-server'] }))).toBe(false);
  });

  it('a command line that cannot be read counts as a server (it exists)', () => {
    expect(isServerProcess(5, probe({ cmdline: () => undefined }))).toBe(true);
  });

  it('a reused pid of another program is no server', () => {
    expect(isServerProcess(5, probe({ cmdline: () => ['vim', 'agentdeck-server.md'] }))).toBe(false);
    expect(isServerProcess(5, probe({ cmdline: () => ['node', '/anderes/projekt/dist/cli.js'], packageName: () => 'other' }))).toBe(false);
  });

  it('the server is one', () => {
    expect(isServerProcess(5, probe({ cmdline: () => ['/b/node', '/b/app/server/dist/cli.js'] }))).toBe(true);
  });
});
