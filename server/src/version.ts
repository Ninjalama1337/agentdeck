import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'agentdeck';

/** Version of a checkout without any release tag in its history (or without git). */
const FALLBACK_VERSION = '0.1.0';

/** Repo root — src/ (tsx, vitest) and dist/ (built) both sit two levels below it. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `git describe` output → version string: `v1.2.3` → `1.2.3` (exactly a
 * release), `v1.2.3-4-gabc1234` → `1.2.3-4-gabc1234` (4 commits past it).
 */
export function versionFromDescribe(describe: string): string | undefined {
  const match = /^v(\d+\.\d+\.\d+(?:-\d+-g[0-9a-f]+)?)$/.exec(describe.trim());
  return match?.[1];
}

/** Releases are git tags (`vX.Y.Z`), so the checkout itself knows its version. */
function detectVersion(): string {
  try {
    const describe = execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return versionFromDescribe(describe) ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const VERSION = detectVersion();
