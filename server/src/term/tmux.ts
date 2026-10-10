/**
 * tmux session supervisor for AgentDeck terminals.
 *
 * Runs each terminal shell in a detached tmux session under a dedicated private
 * socket ($XDG_RUNTIME_DIR/agentdeck-tmux.sock). This decouples terminal
 * processes from the Fastify server:
 *
 * - When the server restarts (tsx watch, service reload, crash, agent rebuilds):
 *   the tmux session and everything running inside it (agents, compilers, shells)
 *   STAYS ALIVE in the background.
 * - When the server boots up again, TerminalManager re-attaches node-pty to the
 *   existing tmux session, restores the scrollback, and resumes streaming.
 * - The dedicated socket prevents interference with any user-managed tmux sessions.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BUNDLE_ROOT } from '../version.js';
import { findExecutable } from './presets.js';

let cachedTmuxBin: string | null | undefined = undefined;

export interface ResolveTmuxOptions {
  env?: Record<string, string | undefined>;
  /** Directory of a packaged bundle; its `bin/tmux` wins over the system one. */
  bundleRoot?: string | undefined;
  /** PATH to search (defaults to the augmented server PATH). */
  pathValue?: string;
}

/**
 * Which tmux to run: `AGENTDECK_TMUX` (path or name), else the one shipped in
 * the desktop bundle (`<bundle>/bin/tmux`, built statically), else `tmux` on
 * PATH. An unusable `AGENTDECK_TMUX` is ignored rather than fatal.
 */
export function resolveTmuxBinary(opts: ResolveTmuxOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const find = (name: string) => (opts.pathValue === undefined ? findExecutable(name) : findExecutable(name, opts.pathValue));
  const override = env.AGENTDECK_TMUX?.trim();
  if (override) {
    const found = find(override);
    if (found) return found;
  }
  const bundleRoot = 'bundleRoot' in opts ? opts.bundleRoot : BUNDLE_ROOT;
  if (bundleRoot) {
    const bundled = findExecutable(path.join(bundleRoot, 'bin', 'tmux'));
    if (bundled) return bundled;
  }
  return find('tmux');
}

/** Returns the absolute path to tmux if installed, or undefined. */
export function getTmuxBinary(): string | undefined {
  if (cachedTmuxBin !== undefined) {
    return cachedTmuxBin ?? undefined;
  }
  const resolved = resolveTmuxBinary();
  cachedTmuxBin = resolved ?? null;
  return resolved;
}

/** The tmux to spawn (e.g. for node-pty attach); plain `tmux` only when none was found. */
export function tmuxCommand(): string {
  return getTmuxBinary() ?? 'tmux';
}

/** Check if tmux is installed on the host. */
export function isTmuxAvailable(): boolean {
  return getTmuxBinary() !== undefined;
}

/** Reset cached binary path (useful for testing). */
export function _resetTmuxCache(): void {
  cachedTmuxBin = undefined;
}

/**
 * Dedicated Unix socket for AgentDeck tmux instances.
 * Using a dedicated socket isolates AgentDeck sessions from personal tmux usage.
 */
export function tmuxSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtimeDir, 'agentdeck-tmux.sock');
}

/** Deterministic tmux session name for a given terminal ID. */
export function tmuxSessionName(terminalId: string): string {
  return `ad_${terminalId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Env for tmux calls: server env minus npm-run noise (breaks tmux otherwise). */
function cleanTmuxEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return env;
}

export interface CreateTmuxSessionOptions {
  sessionName: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

/**
 * Creates a new detached tmux session running `shell` with `args`.
 * Sets terminal size, status bar off, and high scrollback limit.
 */
export function createTmuxSession(opts: CreateTmuxSessionOptions): boolean {
  const tmux = getTmuxBinary();
  if (!tmux) return false;
  const sock = tmuxSocketPath();
  const tmuxArgs = [
    '-S', sock,
    'new-session', '-d',
    '-s', opts.sessionName,
    '-c', opts.cwd,
    '-x', String(Math.max(10, opts.cols)),
    '-y', String(Math.max(4, opts.rows)),
  ];

  if (opts.env) {
    for (const [key, val] of Object.entries(opts.env)) {
      if (val !== undefined) {
        tmuxArgs.push('-e', `${key}=${val}`);
      }
    }
  }

  tmuxArgs.push(opts.shell, ...opts.args);

  const cleanEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE_ENV') continue;
    cleanEnv[k] = v;
  }

  try {
    execFileSync(tmux, tmuxArgs, { env: cleanEnv, stdio: 'ignore' });
    applyTmuxSessionOptions(opts.sessionName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Options every AgentDeck session gets (idempotent — also run when re-attaching
 * to a session created before an option existed):
 *
 * - status off: no tmux chrome, the app sees pure terminal output
 * - history-limit: scrollback the client reaches via wheel events
 * - mouse on: tmux consumes wheel events (auto copy-mode scroll) or forwards
 *   them to pane apps that use the mouse. Without it nothing can scroll: tmux
 *   keeps the attached terminal on the alternate screen, so the client-side
 *   xterm never builds scrollback of its own — the history lives in tmux.
 */
export function applyTmuxSessionOptions(sessionName: string): boolean {
  const tmux = getTmuxBinary();
  if (!tmux) return false;
  const sock = tmuxSocketPath();
  const env = cleanTmuxEnv();
  try {
    execFileSync(tmux, ['-S', sock, 'set-option', '-t', sessionName, 'status', 'off'], { env, stdio: 'ignore' });
    execFileSync(tmux, ['-S', sock, 'set-option', '-t', sessionName, 'history-limit', '10000'], { env, stdio: 'ignore' });
    execFileSync(tmux, ['-S', sock, 'set-option', '-t', sessionName, 'mouse', 'on'], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session is currently alive. */
export function hasTmuxSession(sessionName: string): boolean {
  const tmux = getTmuxBinary();
  if (!tmux) return false;
  const sock = tmuxSocketPath();
  try {
    execFileSync(tmux, ['-S', sock, 'has-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session and all processes running inside it. */
export function killTmuxSession(sessionName: string): boolean {
  const tmux = getTmuxBinary();
  if (!tmux) return false;
  const sock = tmuxSocketPath();
  try {
    execFileSync(tmux, ['-S', sock, 'kill-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Resize the tmux window to match client viewport. */
export function resizeTmuxWindow(sessionName: string, cols: number, rows: number): boolean {
  const tmux = getTmuxBinary();
  if (!tmux) return false;
  const sock = tmuxSocketPath();
  try {
    execFileSync(
      tmux,
      ['-S', sock, 'resize-window', '-t', sessionName, '-x', String(Math.max(10, cols)), '-y', String(Math.max(4, rows))],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Captures screen content and scrollback from a tmux pane.
 * Used to seed xterm-headless replay when re-attaching after a server restart.
 */
export function captureTmuxPane(sessionName: string, lines = 1500): string {
  const tmux = getTmuxBinary();
  if (!tmux) return '';
  const sock = tmuxSocketPath();
  try {
    return execFileSync(
      tmux,
      ['-S', sock, 'capture-pane', '-e', '-p', '-S', `-${lines}`, '-t', sessionName],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

/** List all active AgentDeck tmux session names. */
export function listTmuxSessions(prefix = 'ad_'): string[] {
  const tmux = getTmuxBinary();
  if (!tmux) return [];
  const sock = tmuxSocketPath();
  try {
    const raw = execFileSync(tmux, ['-S', sock, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.startsWith(prefix));
  } catch {
    return [];
  }
}
