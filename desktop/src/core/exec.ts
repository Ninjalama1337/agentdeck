import { execFile } from 'node:child_process';
import type { Exec } from './cli';

/** Real `Exec`: runs the program, collects stdout/stderr, enforces the timeout. */
export const nodeExec: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof err.code === 'number') {
          resolve({ code: err.code, stdout, stderr });
        } else if (err.killed) {
          reject(new Error(`timed out after ${Math.round((options.timeoutMs ?? 30_000) / 1000)}s`));
        } else {
          reject(error);
        }
      },
    );
    child.stdin?.end();
  });

