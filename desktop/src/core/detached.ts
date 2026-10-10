import path from 'node:path';
import { readJsonFile, writeFileAtomic, type FileSystem } from './fs';
import { isServerProcess, type ProcessProbe } from './pidfile';

/** Written when the app starts a server itself — tells "ours" from a checkout started by hand. */
export interface DetachedMarker {
  pid: number;
  startedAt: number;
  bin: string;
  /** Bind address the server was started with (0.0.0.0 = reachable from the LAN). */
  host: string;
}

/** The slice of a `ChildProcess` the starter needs. */
export interface SpawnedChild {
  pid?: number;
  unref(): void;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  file: string,
  args: string[],
  options: { detached: true; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv; cwd?: string },
) => SpawnedChild;

export interface DetachedDeps {
  fs: FileSystem;
  markerFile: string;
  logFile: string;
  spawn: SpawnFn;
  /** Opens the log for appending and returns its descriptor. */
  openLog(file: string): number;
  closeFd(fd: number): void;
  /** Looks at processes: is `pid` alive, and is it an AgentDeck server (guards against a recycled pid)? */
  probe: ProcessProbe;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Above this the server log starts over (the previous one is kept as `.1`). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** `server.pid` → pid; null for a missing or garbled file. */
export async function readPidFile(fs: FileSystem, file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await fs.readFile(file)).trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

export function normalizeMarker(raw: unknown): DetachedMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 1) return null;
  return {
    pid: r.pid,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
    bin: typeof r.bin === 'string' ? r.bin : '',
    host: typeof r.host === 'string' && r.host ? r.host : '127.0.0.1',
  };
}

export class DetachedServer {
  constructor(private readonly deps: DetachedDeps) {}

  async readMarker(): Promise<DetachedMarker | null> {
    return normalizeMarker(await readJsonFile(this.deps.fs, this.deps.markerFile));
  }

  /**
   * The marker when the server whose pid file is `pidFile` is the one this app started:
   * same pid as the marker, still alive, and still an AgentDeck server process.
   */
  async inspect(pidFile: string): Promise<DetachedMarker | null> {
    const marker = await this.readMarker();
    if (!marker) return null;
    const pid = await readPidFile(this.deps.fs, pidFile);
    return pid === marker.pid && isServerProcess(pid, this.deps.probe) ? marker : null;
  }

  async isOurs(pidFile: string): Promise<boolean> {
    return (await this.inspect(pidFile)) !== null;
  }

  /**
   * Starts `bin` (the CLI without arguments = the server in the foreground) in
   * its own session with stdout/stderr in the log file, so it outlives the app.
   */
  async start(options: { bin: string; env: NodeJS.ProcessEnv; host: string; cwd?: string }): Promise<number> {
    const { fs, logFile } = this.deps;
    await fs.mkdirp(path.dirname(logFile));
    const size = await fs.size(logFile);
    if (size !== null && size > MAX_LOG_BYTES) await fs.rename(logFile, `${logFile}.1`);
    const fd = this.deps.openLog(logFile);
    try {
      const child = this.deps.spawn(options.bin, [], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: options.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      const pid = child.pid;
      if (pid === undefined) throw new Error('the server process has no pid');
      const marker: DetachedMarker = { pid, startedAt: this.deps.now(), bin: options.bin, host: options.host };
      await writeFileAtomic(fs, this.deps.markerFile, `${JSON.stringify(marker)}\n`);
      return pid;
    } finally {
      this.deps.closeFd(fd);
    }
  }

  /**
   * Stops the server this app started: SIGTERM (the server shuts down cleanly and
   * removes its pid file), SIGKILL when it does not go away. Terminals live in
   * tmux and survive either way. Refuses to touch a server that is not ours.
   */
  async stop(pidFile: string, options: { graceMs?: number } = {}): Promise<void> {
    const marker = await this.readMarker();
    const filePid = await readPidFile(this.deps.fs, pidFile);
    const pid = filePid ?? marker?.pid ?? null;
    if (!marker || pid === null || pid !== marker.pid) {
      throw new Error('This server was not started by the app — stop it where you started it.');
    }
    if (isServerProcess(pid, this.deps.probe)) {
      this.deps.kill(pid, 'SIGTERM');
      if (!(await this.waitForExit(pid, options.graceMs ?? 10_000))) {
        this.deps.kill(pid, 'SIGKILL');
        await this.waitForExit(pid, 3_000);
      }
    }
    await this.deps.fs.remove(this.deps.markerFile);
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.probe.alive(pid)) {
      if (this.deps.now() >= deadline) return false;
      await this.deps.sleep(150);
    }
    return true;
  }
}
