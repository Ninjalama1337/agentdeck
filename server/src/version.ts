import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'agentdeck';

/** Version of a checkout without any release tag in its history (or without git). */
const FALLBACK_VERSION = '0.1.0';

/**
 * Repo root — src/ (tsx, vitest) and dist/ (built) both sit two levels below it.
 * In a packaged bundle this is its `app/` directory (`app/server/dist/…`).
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** What a version string may look like (also guards paths built from it). */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

/**
 * `git describe` output → version string: `v1.2.3` → `1.2.3` (exactly a
 * release), `v1.2.3-4-gabc1234` → `1.2.3-4-gabc1234` (4 commits past it).
 */
export function versionFromDescribe(describe: string): string | undefined {
  const match = /^v(\d+\.\d+\.\d+(?:-\d+-g[0-9a-f]+)?)$/.exec(describe.trim());
  return match?.[1];
}

/** `{"version":"1.2.3"}` → `1.2.3`; undefined for a missing or malformed file. */
export function readVersionJson(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && VERSION_SHAPE.test(parsed.version) ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Root of a packaged bundle (`bin/`, `node/`, `app/`, `version.json`): the parent of its `app/` dir. */
export function bundleRootOf(repoRoot: string): string {
  return path.resolve(repoRoot, '..');
}

export interface VersionInfo {
  version: string;
  /** Runs from a packaged bundle: `version.json` next to `app/` and no git checkout. */
  packaged: boolean;
}

export interface ResolveVersionOptions {
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  /** `git describe` output of the checkout, if any (tests inject it). */
  describe?: (repoRoot: string) => string | undefined;
}

function gitDescribe(repoRoot: string): string | undefined {
  try {
    return execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return undefined;
  }
}

/**
 * Version of this build: `AGENTDECK_VERSION` env, else the bundle's
 * `version.json`, else the checkout's release tag (`git describe`), else the
 * fallback. Releases are git tags (`vX.Y.Z`), so a checkout knows its version.
 */
export function resolveVersion(opts: ResolveVersionOptions = {}): VersionInfo {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  // A checkout is a checkout, whatever file sits next to it.
  const bundled = fs.existsSync(path.join(repoRoot, '.git'))
    ? undefined
    : readVersionJson(path.join(bundleRootOf(repoRoot), 'version.json'));
  const packaged = bundled !== undefined;
  const fromEnv = env.AGENTDECK_VERSION?.trim().replace(/^v(?=\d)/, '');
  if (fromEnv && VERSION_SHAPE.test(fromEnv)) return { version: fromEnv, packaged };
  if (bundled) return { version: bundled, packaged };
  const describe = (opts.describe ?? gitDescribe)(repoRoot);
  return { version: (describe ? versionFromDescribe(describe) : undefined) ?? FALLBACK_VERSION, packaged };
}

const RESOLVED = resolveVersion();

export const VERSION = RESOLVED.version;

/** True when this server is part of the desktop app bundle (it updates with the app, not via git). */
export const PACKAGED = RESOLVED.packaged;

/** The bundle directory when packaged (bin/tmux, node/, version.json live there). */
export const BUNDLE_ROOT: string | undefined = PACKAGED ? bundleRootOf(REPO_ROOT) : undefined;
