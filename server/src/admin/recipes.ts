/**
 * Fixed admin recipes (CONTRACT.md "Admin recipes"): per agent + kind the
 * exact command the server runs — never free-form. Logins that can only
 * happen inside an interactive TUI/IDE are exposed as AdminCapabilities with
 * an `unavailableReason` instead of a recipe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminCapability, AdminJobKind, AgentId } from '@agentdeck/shared';
import { AGENT_IDS } from '../config.js';
import { httpError } from '../http/errors.js';
import { zcodeProviderEnv } from '../agents/zcode.js';
import { expandHome } from '../util/paths.js';
import { markClaudeOnboarded } from './claudeOnboarding.js';

export const ADMIN_JOB_KINDS = ['update', 'install', 'login'] as const;

/** One runnable admin command. `envAdd` is merged over process.env. */
export interface AdminRecipe {
  kind: AdminJobKind;
  /** Human command headline shown in the UI ("claude update"). */
  label: string;
  command: string;
  args: string[];
  cwd: string;
  envAdd?: Record<string, string>;
  /**
   * Run in a pseudo-terminal and accept input from the app. Needed for
   * sign-ins that wait for a pasted code or let the user pick from a list.
   */
  interactive?: boolean;
  /** Follow-up after the command exited successfully. */
  onSuccess?: () => void;
}

const home = (): string => os.homedir();

/** PATH with an extra directory prepended (so recipes find their tooling). */
function pathPrepended(dir: string): Record<string, string> {
  return { PATH: `${expandHome(dir)}:${process.env.PATH ?? ''}` };
}

/**
 * Resolves scripts/update-zcode.sh relative to this file — like findWebDist:
 * src/admin (tsx dev/vitest) → ../../scripts, dist/admin (built) → ../../../scripts.
 */
export function resolveRepoScript(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../scripts', name),
    path.resolve(here, '../../../scripts', name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

function repoRoot(): string {
  return path.dirname(path.dirname(resolveRepoScript('update-zcode.sh')));
}

const ANTIGRAVITY_LOGIN_LAUNCH =
  'echo "Opening Antigravity — sign in with your Google account in the window that appears." && nohup flatpak run com.google.Antigravity >/dev/null 2>&1 &';

/**
 * What the app may offer per agent: available recipes as plain capabilities,
 * impossible ones with an `unavailableReason`.
 */
export function adminCapabilities(agentId: AgentId): AdminCapability[] {
  if (!(AGENT_IDS as readonly string[]).includes(agentId)) {
    throw httpError(404, 'NOT_FOUND', `Unknown agent: ${agentId}`);
  }
  switch (agentId) {
    case 'claude':
      return [
        { kind: 'update', label: 'claude update' },
        { kind: 'install', label: 'npm install -g @anthropic-ai/claude-code' },
        { kind: 'login', label: 'claude auth login (browser sign-in)' },
      ];
    case 'zcode': {
      const label = 'scripts/update-zcode.sh';
      return [
        { kind: 'update', label },
        { kind: 'install', label },
        { kind: 'login', label: 'zcode login zai' },
      ];
    }
    case 'antigravity':
      return [
        { kind: 'update', label: 'flatpak update -y com.google.Antigravity' },
        { kind: 'install', label: 'flatpak install -y flathub com.google.Antigravity' },
        { kind: 'login', label: 'Open Antigravity for Google sign-in' },
      ];
    case 'codex':
      return [
        { kind: 'update', label: 'codex update' },
        { kind: 'install', label: 'npm install -g @openai/codex@latest' },
        { kind: 'login', label: 'codex login --device-auth (sign-in page + one-time code)' },
      ];
    case 'opencode':
      return [
        { kind: 'update', label: 'npm install -g @opencode/cli@latest' },
        { kind: 'install', label: 'npm install -g @opencode/cli' },
        { kind: 'login', label: 'opencode auth login (provider and authentication method)' },
      ];
  }
}

/**
 * Recipe for an available agent+kind. Throws HttpError 400 carrying the
 * `unavailableReason` for unavailable kinds, 404 for unknown agents.
 */
export function recipeFor(agentId: AgentId, kind: AdminJobKind): AdminRecipe {
  const capability = adminCapabilities(agentId).find((c) => c.kind === kind);
  if (!capability) {
    throw httpError(404, 'NOT_FOUND', `Unknown agent: ${agentId}`);
  }
  if (capability.unavailableReason) {
    throw httpError(400, 'ADMIN_JOB_UNAVAILABLE', capability.unavailableReason);
  }
  switch (agentId) {
    case 'claude':
      if (kind === 'update') {
        return { kind, label: capability.label, command: 'claude', args: ['update'], cwd: home() };
      }
      if (kind === 'login') {
        // `auth login` saves the sign-in (setup-token only prints a token). It
        // prints an OAuth URL and waits for the browser callback or, when the
        // browser runs on another device, for the code pasted from the app —
        // so it needs a terminal and input.
        return {
          kind,
          label: capability.label,
          command: 'claude',
          args: ['auth', 'login'],
          cwd: home(),
          interactive: true,
          // Without this the next `claude` terminal asks to sign in again.
          onSuccess: () => void markClaudeOnboarded(),
        };
      }
      return {
        kind,
        label: capability.label,
        command: 'npm',
        args: ['install', '-g', '@anthropic-ai/claude-code'],
        cwd: home(),
      };
    case 'zcode':
      if (kind === 'login') {
        // The OAuth flow's final config write needs the standalone provider
        // registry paths — without them it fails with "Login succeeded but
        // updating ZCode config failed" even though the browser login worked.
        return {
          kind,
          label: capability.label,
          command: 'zcode',
          args: ['login', 'zai'],
          cwd: home(),
          envAdd: { ...pathPrepended('~/.local/bin'), ...zcodeProviderEnv() },
        };
      }
      // update + install share the one build-from-source script.
      return {
        kind,
        label: capability.label,
        command: resolveRepoScript('update-zcode.sh'),
        args: [],
        cwd: repoRoot(),
        envAdd: pathPrepended('~/.local/opt/node-24/bin'),
      };
    case 'antigravity':
      if (kind === 'update') {
        return {
          kind,
          label: capability.label,
          command: 'flatpak',
          args: ['update', '-y', 'com.google.Antigravity'],
          cwd: home(),
        };
      }
      if (kind === 'login') {
        // Google sign-in lives inside the IDE window — the job opens it and
        // finishes immediately (fire & forget via sh).
        return {
          kind,
          label: capability.label,
          command: 'sh',
          args: ['-c', ANTIGRAVITY_LOGIN_LAUNCH],
          cwd: home(),
        };
      }
      return {
        kind,
        label: capability.label,
        command: 'flatpak',
        args: ['install', '-y', 'flathub', 'com.google.Antigravity'],
        cwd: home(),
      };
    case 'codex':
      if (kind === 'login') {
        // Plain `codex login` redirects the browser to localhost:1455 on the
        // server, which a phone cannot reach. The device flow prints a page
        // and a one-time code instead and waits until the sign-in is done.
        return { kind, label: capability.label, command: 'codex', args: ['login', '--device-auth'], cwd: home() };
      }
      if (kind === 'update') {
        // Updates whichever way codex was installed (standalone or npm);
        // `npm install -g` would collide with a standalone install.
        return { kind, label: capability.label, command: 'codex', args: ['update'], cwd: home() };
      }
      return {
        kind,
        label: capability.label,
        command: 'npm',
        args: ['install', '-g', '@openai/codex@latest'],
        cwd: home(),
      };
    case 'opencode':
      if (kind === 'update') {
        return {
          kind,
          label: capability.label,
          command: 'npm',
          args: ['install', '-g', '@opencode/cli@latest'],
          cwd: home(),
        };
      }
      if (kind === 'login') {
        // OpenCode v2 uses `auth login`: the provider-specific authentication
        // method can be an API key, OAuth, or a provider command.
        return {
          kind,
          label: capability.label,
          command: 'opencode',
          args: ['auth', 'login'],
          cwd: home(),
          interactive: true,
        };
      }
      return {
        kind,
        label: capability.label,
        command: 'npm',
        args: ['install', '-g', '@opencode/cli'],
        cwd: home(),
      };
  }
}
