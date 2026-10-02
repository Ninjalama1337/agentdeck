/**
 * Claude Code runs its first-start setup (theme, then sign-in) until its
 * config says the setup is complete — even when a sign-in is already stored.
 * A sign-in done from the app (`claude auth login`) stores the login but
 * leaves that flag unset, so the next terminal would ask to sign in again.
 * This marks the setup complete once a stored sign-in exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudePaths {
  /** Claude Code's settings file (`hasCompletedOnboarding` lives here). */
  config: string;
  /** Stored sign-in; only its existence is checked, it is never read. */
  credentials: string;
}

export function claudePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ClaudePaths {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir
    ? { config: path.join(dir, '.claude.json'), credentials: path.join(dir, '.credentials.json') }
    : { config: path.join(home, '.claude.json'), credentials: path.join(home, '.claude', '.credentials.json') };
}

/**
 * Sets `hasCompletedOnboarding` when a sign-in is stored and the flag is
 * missing. Returns true when the config was changed. A config that is not a
 * JSON object is left alone.
 */
export function markClaudeOnboarded(paths: ClaudePaths = claudePaths()): boolean {
  if (!fs.existsSync(paths.credentials)) return false;
  let config: Record<string, unknown> = {};
  let mode = 0o600;
  if (fs.existsSync(paths.config)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    config = parsed as Record<string, unknown>;
    mode = fs.statSync(paths.config).mode & 0o777;
  }
  if (config.hasCompletedOnboarding === true) return false;
  config.hasCompletedOnboarding = true;
  const tmp = `${paths.config}.agentdeck-${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  fs.renameSync(tmp, paths.config);
  return true;
}
