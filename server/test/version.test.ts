import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleRootOf, readVersionJson, resolveVersion } from '../src/version.js';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-version-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A bundle-shaped tree: `<tmp>/version.json` next to `<tmp>/app`. */
function bundle(versionJson: string | undefined, opts: { git?: boolean } = {}): string {
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app, { recursive: true });
  if (versionJson !== undefined) fs.writeFileSync(path.join(tmp, 'version.json'), versionJson);
  if (opts.git) fs.mkdirSync(path.join(app, '.git'));
  return app;
}

const noGit = () => undefined;

describe('resolveVersion', () => {
  it('reads version.json next to app/ and calls the server packaged', () => {
    const repoRoot = bundle('{"version":"1.4.2"}');
    expect(bundleRootOf(repoRoot)).toBe(tmp);
    expect(resolveVersion({ env: {}, repoRoot, describe: noGit })).toEqual({ version: '1.4.2', packaged: true });
  });

  it('lets AGENTDECK_VERSION win and strips a leading v', () => {
    const repoRoot = bundle('{"version":"1.4.2"}');
    expect(resolveVersion({ env: { AGENTDECK_VERSION: 'v2.0.0' }, repoRoot, describe: noGit })).toEqual({
      version: '2.0.0',
      packaged: true,
    });
    // ... also in a checkout, where it does not make the server "packaged".
    const checkout = bundle(undefined, { git: true });
    expect(resolveVersion({ env: { AGENTDECK_VERSION: '9.9.9' }, repoRoot: checkout, describe: () => 'v1.0.0' })).toEqual({
      version: '9.9.9',
      packaged: false,
    });
  });

  it('ignores a malformed AGENTDECK_VERSION', () => {
    const repoRoot = bundle('{"version":"1.4.2"}');
    expect(resolveVersion({ env: { AGENTDECK_VERSION: '../../etc' }, repoRoot, describe: noGit }).version).toBe('1.4.2');
  });

  it('falls back to git describe, then to the built-in fallback', () => {
    const repoRoot = bundle(undefined, { git: true });
    expect(resolveVersion({ env: {}, repoRoot, describe: () => 'v0.11.0-4-gabc1234\n' })).toEqual({
      version: '0.11.0-4-gabc1234',
      packaged: false,
    });
    expect(resolveVersion({ env: {}, repoRoot, describe: noGit })).toEqual({ version: '0.1.0', packaged: false });
    expect(resolveVersion({ env: {}, repoRoot, describe: () => 'nightly' }).version).toBe('0.1.0');
  });

  it('a checkout is never packaged, even with a version.json lying next to it', () => {
    const repoRoot = bundle('{"version":"5.0.0"}', { git: true });
    expect(resolveVersion({ env: {}, repoRoot, describe: () => 'v1.2.3' })).toEqual({ version: '1.2.3', packaged: false });
  });

  it('a broken version.json does not make the server packaged', () => {
    const repoRoot = bundle('{not json');
    expect(resolveVersion({ env: {}, repoRoot, describe: noGit })).toEqual({ version: '0.1.0', packaged: false });
    expect(readVersionJson(path.join(tmp, 'missing.json'))).toBeUndefined();
    fs.writeFileSync(path.join(tmp, 'v.json'), '{"version":42}');
    expect(readVersionJson(path.join(tmp, 'v.json'))).toBeUndefined();
  });
});
