/**
 * `<dataDir>/server.pid`: the running server's pid as plain text, for the CLI
 * and the desktop shell (stop a detached server). Written once the server
 * listens, removed on a clean exit; a crash leaves it behind, so readers must
 * check it is still ours (`inspectPidFile`) — pids get reused.
 *
 * Recognizing "this pid is an AgentDeck server" (`looksLikeServer`), by the
 * process's argv (`/proc/<pid>/cmdline`, arguments checked one by one):
 *  1. the program (argv[0]) is named exactly `agentdeck-server`, or a shell
 *     runs a script of that exact name — the bundle launcher, and
 *  2. any argument is a path `…/server/dist/(index|cli).js` or
 *     `…/server/src/(index|cli).ts` (resolved against the process's cwd when
 *     relative) whose `server/package.json` is named `@agentdeck/server`:
 *     a checkout (`node server/dist/index.js`, `tsx src/index.ts`) or a bundle
 *     (`…/app/server/dist/cli.js`) — and not just any project with a
 *     `dist/cli.js`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite.js';

export const SERVER_PACKAGE_NAME = '@agentdeck/server';

const LAUNCHER = 'agentdeck-server';
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);

/** `…/server/dist/index.js`, `…/server/src/cli.ts` … */
const SERVER_ENTRY = /\/server\/(?:dist\/(?:index|cli)\.js|src\/(?:index|cli)\.ts)$/;

export function pidFilePath(dataDir: string): string {
  return path.join(dataDir, 'server.pid');
}

/** The pid in the file, or undefined when it is missing or not a pid. */
export function readPidFile(dataDir: string): number | undefined {
  try {
    const text = fs.readFileSync(pidFilePath(dataDir), 'utf8').trim();
    if (!/^\d+$/.test(text)) return undefined;
    const pid = Number(text);
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file — but only while it still names `pid`, so a second server never deletes the first one's. */
export function removePidFile(dataDir: string, pid = process.pid): void {
  try {
    if (readPidFile(dataDir) === pid) fs.rmSync(pidFilePath(dataDir), { force: true });
  } catch {
    // best effort on the way out
  }
}

/** Process probes, injectable for tests. */
export interface PidProbe {
  /** The process exists (signal 0). */
  alive(pid: number): boolean;
  /** Arguments of the process (argv), or undefined when they cannot be read. */
  cmdline(pid: number): string[] | undefined;
  /** Working directory of the process, to resolve relative script paths. */
  cwd?(pid: number): string | undefined;
  /** `name` of the package.json at `file`, or undefined. */
  packageName?(file: string): string | undefined;
}

function readPackageName(file: string): string | undefined {
  try {
    const name = (JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

export const systemPidProbe: PidProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: it exists but belongs to someone else.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  cmdline(pid) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const args = raw.split('\0');
      if (args.at(-1) === '') args.pop();
      return args.length > 0 ? args : undefined;
    } catch {
      return undefined;
    }
  },
  cwd(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  },
  packageName: readPackageName,
};

/** Is this argv an AgentDeck server (see the rules in the file header)? */
export function looksLikeServer(
  args: string[],
  context: { cwd?: string | undefined; packageName?: (file: string) => string | undefined } = {},
): boolean {
  const readName = context.packageName ?? readPackageName;
  // 1. The bundle launcher, as program or as the script of a shell (`vim …/agentdeck-server` is no server).
  const program = path.basename(args[0] ?? '');
  if (program === LAUNCHER) return true;
  if (SHELLS.has(program) && path.basename(args[1] ?? '') === LAUNCHER) return true;
  // 2. A server entry point of an AgentDeck package.
  for (const arg of args.slice(1)) {
    if (arg.startsWith('-')) continue;
    const entry = path.isAbsolute(arg) ? path.normalize(arg) : context.cwd ? path.resolve(context.cwd, arg) : undefined;
    if (entry === undefined || !SERVER_ENTRY.test(entry)) continue;
    if (readName(path.join(path.dirname(path.dirname(entry)), 'package.json')) === SERVER_PACKAGE_NAME) return true;
  }
  return false;
}

export interface PidFileState {
  /** The file exists and holds a pid. */
  pid: number;
  /** The process exists and is an AgentDeck server (when its command line cannot be read, existing is enough). */
  running: boolean;
  /** The file names nothing (or a foreign process): the server died without cleaning up. */
  stale: boolean;
}

/** What the pid file says, checked against the process table. undefined = no (valid) pid file. */
export function inspectPidFile(dataDir: string, probe: PidProbe = systemPidProbe): PidFileState | undefined {
  const pid = readPidFile(dataDir);
  if (pid === undefined) return undefined;
  if (!probe.alive(pid)) return { pid, running: false, stale: true };
  const args = probe.cmdline(pid);
  const running =
    args === undefined ||
    looksLikeServer(args, {
      cwd: probe.cwd?.(pid),
      ...(probe.packageName ? { packageName: probe.packageName } : {}),
    });
  return { pid, running, stale: !running };
}

export type WritePidResult = { written: true } | { written: false; otherPid: number };

/**
 * Writes the pid file (atomically). Another live server already named in it
 * keeps it: two servers on one data dir are not supported, but stopping the
 * second must not invalidate the first one's file.
 */
export function writePidFile(dataDir: string, pid = process.pid, probe: PidProbe = systemPidProbe): WritePidResult {
  const existing = inspectPidFile(dataDir, probe);
  if (existing?.running && existing.pid !== pid) return { written: false, otherPid: existing.pid };
  fs.mkdirSync(dataDir, { recursive: true });
  writeFileAtomicSync(pidFilePath(dataDir), `${pid}\n`, 0o644);
  return { written: true };
}
