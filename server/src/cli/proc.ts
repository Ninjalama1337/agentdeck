/** Looks at a running process through /proc — injectable, so the service logic is tested without one. */
import fs from 'node:fs';

export interface ProcAccess {
  /** The executable of the process (`readlink /proc/<pid>/exe`), a trailing " (deleted)" removed. */
  exe(pid: number): string | undefined;
  /** The environment the process was started with. */
  environ(pid: number): Record<string, string> | undefined;
}

export const systemProc: ProcAccess = {
  exe(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    } catch {
      return undefined;
    }
  },
  environ(pid) {
    try {
      const env: Record<string, string> = {};
      for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      return env;
    } catch {
      return undefined;
    }
  },
};

/** No process information at all (tests; platforms without /proc). */
export const noProc: ProcAccess = { exe: () => undefined, environ: () => undefined };
