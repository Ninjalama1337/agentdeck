/**
 * `<dataDir>/server.pid`: the running server's pid, for the CLI and the desktop
 * shell (stop a detached server). Written once the server listens, removed on a
 * clean exit; a crash leaves it behind, so readers must check it is still ours
 * (`inspectPidFile`) — pids get reused.
 */
import fs from 'node:fs';
import path from 'node:path';

export function pidFilePath(dataDir: string): string {
  return path.join(dataDir, 'server.pid');
}

export function writePidFile(dataDir: string, pid = process.pid): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFilePath(dataDir), `${pid}\n`, { mode: 0o644 });
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
  /** Command line of the process, or undefined when it cannot be read. */
  cmdline(pid: number): string | undefined;
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
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      return undefined;
    }
  },
};

/** Does this command line look like an AgentDeck server (checkout `index.js`, bundle `cli.js`, `tsx src/index.ts`)? */
export function looksLikeServer(cmdline: string): boolean {
  return /(?:dist|src)\/(?:index|cli)\.(?:js|ts)(?:\s|$)|agentdeck-server/.test(cmdline);
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
  const cmdline = probe.cmdline(pid);
  const running = cmdline === undefined || looksLikeServer(cmdline);
  return { pid, running, stale: !running };
}
