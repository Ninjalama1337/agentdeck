/**
 * Is this pid an AgentDeck server? Ported 1:1 from server/src/util/pidfile.ts (the shell cannot
 * import the server) — keep the two in step. The process's argv is checked argument by argument:
 *  1. the program (argv[0]) is named exactly `agentdeck-server`, or a shell runs a script of that
 *     exact name — the bundle launcher, or
 *  2. any argument is a path `…/server/dist/(index|cli).js` or `…/server/src/(index|cli).ts`
 *     (resolved against the process's cwd when relative) whose `server/package.json` is named
 *     `@agentdeck/server`: a checkout or a bundle — and not just any project with a `dist/cli.js`.
 * Pids get reused, so a signal is only ever sent to a process that passes this.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SERVER_PACKAGE_NAME = '@agentdeck/server';

const LAUNCHER = 'agentdeck-server';
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);

/** `…/server/dist/index.js`, `…/server/src/cli.ts` … */
const SERVER_ENTRY = /\/server\/(?:dist\/(?:index|cli)\.js|src\/(?:index|cli)\.ts)$/;

/** Process probes, injectable for tests. */
export interface ProcessProbe {
  /** The process exists (signal 0; EPERM counts: it exists but belongs to someone else). */
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

export const systemProcessProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
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

/**
 * The process exists and is an AgentDeck server. When its command line cannot be read, existing
 * is enough (same as the server's own check).
 */
export function isServerProcess(pid: number, probe: ProcessProbe = systemProcessProbe): boolean {
  if (!probe.alive(pid)) return false;
  const args = probe.cmdline(pid);
  if (args === undefined) return true;
  return looksLikeServer(args, {
    cwd: probe.cwd?.(pid),
    ...(probe.packageName ? { packageName: probe.packageName } : {}),
  });
}
