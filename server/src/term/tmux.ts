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
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BUNDLE_ROOT } from '../version.js';
import { findExecutable } from './presets.js';

export interface ResolveTmuxOptions {
  env?: Record<string, string | undefined>;
  /** Directory of a packaged bundle; its `bin/tmux` wins over the system one. */
  bundleRoot?: string | undefined;
  /** PATH to search (defaults to the augmented server PATH). */
  pathValue?: string;
  /** Does this tmux run at all? Default: `tmux -V` exits 0. */
  probe?: (bin: string) => string | undefined;
}

export interface TmuxResolution {
  bin?: string;
  /** Candidates that exist but do not run (e.g. a bundled tmux needing a newer glibc), with the reason. */
  rejected: { path: string; reason: string }[];
}

/** `tmux -V`; returns undefined when it ran, else why it did not. */
function runVersion(bin: string): string | undefined {
  const res = spawnSync(bin, ['-V'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) return res.error.message;
  if (res.status !== 0) return (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 300);
  return undefined;
}

/**
 * Which tmux to run: `AGENTDECK_TMUX` (path or name), else the one shipped in
 * the desktop bundle (`<bundle>/bin/tmux`, built mostly static), else `tmux` on
 * PATH. Each candidate must start (`tmux -V`) — a bundled binary that needs a
 * newer glibc than the machine has is passed over for the next one, and
 * reported in `rejected`. An unusable `AGENTDECK_TMUX` is ignored, not fatal.
 */
export function resolveTmux(opts: ResolveTmuxOptions = {}): TmuxResolution {
  const env = opts.env ?? process.env;
  const find = (name: string) => (opts.pathValue === undefined ? findExecutable(name) : findExecutable(name, opts.pathValue));
  const probe = opts.probe ?? runVersion;
  const candidates: string[] = [];
  const override = env.AGENTDECK_TMUX?.trim();
  if (override) candidates.push(find(override) ?? '');
  const bundleRoot = 'bundleRoot' in opts ? opts.bundleRoot : BUNDLE_ROOT;
  if (bundleRoot) candidates.push(findExecutable(path.join(bundleRoot, 'bin', 'tmux')) ?? '');
  candidates.push(find('tmux') ?? '');
  const rejected: TmuxResolution['rejected'] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const problem = probe(candidate);
    if (problem === undefined) return { bin: candidate, rejected };
    rejected.push({ path: candidate, reason: problem });
  }
  return { rejected };
}

export function resolveTmuxBinary(opts: ResolveTmuxOptions = {}): string | undefined {
  return resolveTmux(opts).bin;
}

let cachedResolution: TmuxResolution | undefined;

function resolution(): TmuxResolution {
  cachedResolution ??= resolveTmux();
  return cachedResolution;
}

/** Returns the absolute path to tmux if installed (and runnable), or undefined. */
export function getTmuxBinary(): string | undefined {
  return resolution().bin;
}

/** tmux binaries that were found but do not run on this machine — worth a loud log line. */
export function rejectedTmuxBinaries(): TmuxResolution['rejected'] {
  return resolution().rejected;
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
  cachedResolution = undefined;
  lastTmuxError = undefined;
}

let lastTmuxError: string | undefined;

/** Why the last tmux call that failed unexpectedly failed (for log lines). */
export function lastTmuxFailure(): string | undefined {
  return lastTmuxError;
}

export type TmuxSessionState =
  /** The session exists. */
  | 'alive'
  /** tmux says so itself: no server on the socket, or no such session. */
  | 'absent'
  /** tmux could not tell — a version/protocol mismatch with the running server, a crash, a missing binary … */
  | 'unknown';

/** tmux's own words for "there is no such session / server" (as opposed to "I cannot talk to the server"). */
const ABSENT = /no server running|can't find session|no sessions|session not found|error connecting to .*\((?:No such file or directory|Connection refused)\)/i;

/**
 * Asks tmux whether a session exists. `absent` only when tmux clearly says so;
 * anything else (e.g. "server exited unexpectedly" from a client of another
 * version than the running server) is `unknown` — the caller must not conclude
 * that the session is gone.
 */
export function tmuxSessionState(sessionName: string): TmuxSessionState {
  const tmux = getTmuxBinary();
  if (!tmux) return 'unknown';
  const res = spawnSync(tmux, ['-S', tmuxSocketPath(), 'has-session', '-t', sessionName], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (res.error) {
    lastTmuxError = `${tmux}: ${res.error.message}`;
    return 'unknown';
  }
  if (res.status === 0) return 'alive';
  const stderr = String(res.stderr ?? '').trim();
  if (res.status === 1 && ABSENT.test(stderr)) return 'absent';
  lastTmuxError = `${tmux} has-session: ${stderr || `exit ${res.status}`}`;
  return 'unknown';
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
    execFileSync(tmux, tmuxArgs, { env: cleanEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    applyTmuxSessionOptions(opts.sessionName);
    return true;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    lastTmuxError = `${tmux} new-session: ${stderr || (err instanceof Error ? err.message : String(err))}`;
    return false;
  }
}

/**
 * Options every AgentDeck session gets (idempotent — also run when re-attaching
 * to a session created before an option existed):
 *
 * - status off: no tmux chrome, the app sees pure terminal output
 * - history-limit: scrollback the client reaches via wheel events
 * - set-clipboard on: tmux's own copies and the OSC 52 of pane apps go out as
 *   OSC 52; the app writes them to the device clipboard
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
    // Copies (tmux selection, apps writing OSC 52) reach the app, which puts them on the device clipboard.
    execFileSync(tmux, ['-S', sock, 'set-option', '-s', 'set-clipboard', 'on'], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session is currently alive. */
export function hasTmuxSession(sessionName: string): boolean {
  return tmuxSessionState(sessionName) === 'alive';
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

/** PID of the process in the session's pane (the login shell), or undefined. */
export function tmuxPanePid(sessionName: string): number | undefined {
  const tmux = getTmuxBinary();
  if (!tmux) return undefined;
  try {
    const raw = execFileSync(tmux, ['-S', tmuxSocketPath(), 'list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number(raw.split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
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
