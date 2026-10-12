import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** A failure with a message fit for the terminal; the CLI prints it and exits non-zero. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ExecResult {
  /** Exit code; 127 when the command does not exist. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and never throws — the service logic is tested with a fake instead of a real systemd. */
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/** `systemctl --user` talks to the user manager through XDG_RUNTIME_DIR; a GUI-less shell may lack it. */
function withRuntimeDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.XDG_RUNTIME_DIR || typeof process.getuid !== 'function') return env;
  const dir = `/run/user/${process.getuid()}`;
  return fs.existsSync(dir) ? { ...env, XDG_RUNTIME_DIR: dir } : env;
}

export const systemExec: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: withRuntimeDir(process.env), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = err as NodeJS.ErrnoException & { code?: number | string };
        const code = typeof failure.code === 'number' ? failure.code : failure.code === 'ENOENT' ? 127 : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || failure.message });
      },
    );
  });
