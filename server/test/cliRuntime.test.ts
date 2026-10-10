import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/cli/exec.js';
import {
  currentRuntimeDir,
  inspectBundle,
  installRuntime,
  launcherPath,
  pruneRuntimes,
  removeRuntime,
  runtimeDirOfExe,
  runtimePaths,
  runtimeVersionOf,
  switchCurrent,
} from '../src/cli/runtime.js';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-runtime-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal bundle: launcher, node, app tree, version.json. */
function makeBundle(version: string, name = `bundle-${version}`, extra = ''): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app/server/dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app/node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/agentdeck-server'), '#!/bin/sh\necho launcher\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'node/bin/node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'app/server/dist/cli.js'), `// ${extra}\n`);
  fs.symlinkSync('../../server/dist/cli.js', path.join(root, 'app/node_modules/.bin/agentdeck-server'));
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version, extra }));
  return root;
}

const paths = () => runtimePaths({ XDG_DATA_HOME: path.join(tmp, 'xdg') }, path.join(tmp, 'home'));

describe('runtime paths', () => {
  it('follow XDG_DATA_HOME, else ~/.local/share', () => {
    expect(runtimePaths({ XDG_DATA_HOME: '/x/data' }, '/h')).toEqual({
      dataHome: '/x/data/agentdeck',
      runtimeRoot: '/x/data/agentdeck/runtime',
      currentLink: '/x/data/agentdeck/runtime/current',
    });
    expect(runtimePaths({}, '/h').runtimeRoot).toBe('/h/.local/share/agentdeck/runtime');
    // a relative XDG_DATA_HOME is not valid per the spec
    expect(runtimePaths({ XDG_DATA_HOME: 'rel' }, '/h').runtimeRoot).toBe('/h/.local/share/agentdeck/runtime');
    expect(launcherPath(runtimePaths({}, '/h'))).toBe('/h/.local/share/agentdeck/runtime/current/bin/agentdeck-server');
  });
});

describe('inspectBundle', () => {
  it('reads a complete bundle', () => {
    const root = makeBundle('1.2.3');
    expect(inspectBundle(root)).toMatchObject({ root, version: '1.2.3' });
  });

  it('says what is wrong with a non-bundle', () => {
    expect(() => inspectBundle(path.join(tmp, 'nothing'))).toThrow(CliError);
    const root = makeBundle('1.0.0');
    fs.rmSync(path.join(root, 'node/bin/node'));
    expect(() => inspectBundle(root)).toThrow(/incomplete \(missing node\/bin\/node\)/);
    const evil = makeBundle('../../escape', 'evil');
    expect(() => inspectBundle(evil)).toThrow(/usable "version"/);
  });
});

describe('installRuntime', () => {
  it('copies the bundle to runtime/<version> with modes and symlinks intact', () => {
    const bundle = inspectBundle(makeBundle('1.2.3'));
    const result = installRuntime(bundle, paths());
    expect(result).toEqual({ dir: path.join(paths().runtimeRoot, '1.2.3'), copied: true, replaced: false });
    const copied = path.join(result.dir, 'bin/agentdeck-server');
    expect(fs.statSync(copied).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(result.dir, 'node/bin/node')).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(result.dir, 'app/node_modules/.bin/agentdeck-server'))).toBe('../../server/dist/cli.js');
    // no staging leftovers
    expect(fs.readdirSync(paths().runtimeRoot)).toEqual(['1.2.3']);
  });

  it('leaves the copy writable even when the source was read-only', () => {
    const root = makeBundle('2.0.0');
    fs.chmodSync(path.join(root, 'app/server/dist/cli.js'), 0o444);
    fs.chmodSync(path.join(root, 'app/server/dist'), 0o555);
    try {
      const { dir } = installRuntime(inspectBundle(root), paths());
      expect(fs.statSync(path.join(dir, 'app/server/dist')).mode & 0o200).toBe(0o200);
      expect(fs.statSync(path.join(dir, 'app/server/dist/cli.js')).mode & 0o200).toBe(0o200);
    } finally {
      fs.chmodSync(path.join(root, 'app/server/dist'), 0o755);
    }
  });

  it('is idempotent for the same build', () => {
    const bundle = inspectBundle(makeBundle('1.2.3'));
    installRuntime(bundle, paths());
    const again = installRuntime(bundle, paths());
    expect(again).toMatchObject({ copied: false, replaced: false });
  });

  it('swaps a copy of the same version for a different build', () => {
    installRuntime(inspectBundle(makeBundle('1.2.3', 'one', 'build-1')), paths());
    const second = installRuntime(inspectBundle(makeBundle('1.2.3', 'two', 'build-2')), paths());
    expect(second).toMatchObject({ copied: true, replaced: true });
    expect(fs.readFileSync(path.join(second.dir, 'app/server/dist/cli.js'), 'utf8')).toContain('build-2');
    expect(fs.readdirSync(paths().runtimeRoot)).toEqual(['1.2.3']);
  });

  it('does not copy a runtime onto itself when run from runtime/current', () => {
    installRuntime(inspectBundle(makeBundle('1.2.3')), paths());
    switchCurrent(paths(), path.join(paths().runtimeRoot, '1.2.3'));
    const viaCurrent = inspectBundle(paths().currentLink);
    const result = installRuntime(viaCurrent, paths());
    expect(result).toMatchObject({ copied: false, replaced: false });
    expect(result.dir).toBe(fs.realpathSync(path.join(paths().runtimeRoot, '1.2.3')));
    expect(fs.readdirSync(paths().runtimeRoot).sort()).toEqual(['1.2.3', 'current']);
  });
});

describe('current symlink', () => {
  it('flips atomically between versions and stays relative', () => {
    const p = paths();
    const a = installRuntime(inspectBundle(makeBundle('1.0.0')), p).dir;
    const b = installRuntime(inspectBundle(makeBundle('1.1.0')), p).dir;
    switchCurrent(p, a);
    expect(fs.readlinkSync(p.currentLink)).toBe('1.0.0');
    expect(currentRuntimeDir(p)).toBe(fs.realpathSync(a));
    switchCurrent(p, b);
    expect(currentRuntimeDir(p)).toBe(fs.realpathSync(b));
    expect(runtimeVersionOf(fs.realpathSync(p.currentLink))).toBe('1.1.0');
    expect(fs.existsSync(launcherPath(p))).toBe(true);
    expect(fs.readdirSync(p.runtimeRoot).filter((n) => n.startsWith('.'))).toEqual([]);
  });
});

describe('pruneRuntimes', () => {
  function install(version: string, ageMs: number) {
    const dir = installRuntime(inspectBundle(makeBundle(version)), paths()).dir;
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
    return dir;
  }

  it('keeps the current version and the most recent other, removes the rest', () => {
    const p = paths();
    install('1.0.0', 4000);
    install('1.1.0', 3000);
    install('1.2.0', 2000);
    const newest = install('1.3.0', 1000);
    switchCurrent(p, newest);
    expect(pruneRuntimes(p).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(fs.readdirSync(p.runtimeRoot).sort()).toEqual(['1.2.0', '1.3.0', 'current']);
  });

  it('never removes the current version, even when it is the oldest (a downgrade)', () => {
    const p = paths();
    const oldest = install('1.0.0', 9000);
    install('1.1.0', 3000);
    install('1.2.0', 2000);
    switchCurrent(p, oldest);
    pruneRuntimes(p);
    const left = fs.readdirSync(p.runtimeRoot).sort();
    expect(left).toContain('1.0.0');
    expect(left).toHaveLength(3); // current + link + the newest other
    expect(left).toContain('1.2.0');
  });

  it('never removes a protected directory (a running server loads modules from it), nor the current one', () => {
    const p = paths();
    const running = install('1.0.0', 9000);
    install('1.1.0', 3000);
    install('1.2.0', 2000);
    const current = install('1.3.0', 1000);
    switchCurrent(p, current);
    expect(pruneRuntimes(p, 2, [running]).sort()).toEqual(['1.1.0', '1.2.0']);
    expect(fs.readdirSync(p.runtimeRoot).sort()).toEqual(['1.0.0', '1.3.0', 'current']);
  });

  it('cleans up interrupted installs but not fresh ones', () => {
    const p = paths();
    const dir = install('1.0.0', 1000);
    switchCurrent(p, dir);
    const stale = path.join(p.runtimeRoot, '.install-0.9.0-1');
    const fresh = path.join(p.runtimeRoot, '.install-1.1.0-2');
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(stale, old, old);
    pruneRuntimes(p);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('copes with a missing runtime dir', () => {
    expect(pruneRuntimes(paths())).toEqual([]);
  });
});

describe('runtimeDirOfExe', () => {
  it('names the runtime directory a node binary belongs to — and only those inside the runtime tree', () => {
    const { dir } = installRuntime(inspectBundle(makeBundle('1.0.0')), paths());
    const real = fs.realpathSync(dir);
    expect(runtimeDirOfExe(path.join(real, 'node/bin/node'), paths())).toBe(real);
    expect(runtimeDirOfExe('/usr/bin/node', paths())).toBeUndefined();
    expect(runtimeDirOfExe(path.join(tmp, 'elsewhere/node/bin/node'), paths())).toBeUndefined();
  });
});

describe('removeRuntime', () => {
  it('deletes the runtime tree', () => {
    installRuntime(inspectBundle(makeBundle('1.0.0')), paths());
    expect(removeRuntime(paths())).toBe(true);
    expect(fs.existsSync(paths().runtimeRoot)).toBe(false);
    expect(removeRuntime(paths())).toBe(false);
  });

  it('keeps it while the running CLI lives inside', () => {
    const { dir } = installRuntime(inspectBundle(makeBundle('1.0.0')), paths());
    expect(removeRuntime(paths(), dir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    expect(removeRuntime(paths(), makeBundle('9.9.9', 'elsewhere'))).toBe(true);
  });
});
