/**
 * UpdateManager: server self-update to the latest GitHub release.
 *
 * - `info()` answers "what runs here, what is the latest release" — the
 *   release lookup is cached (CHECK_TTL_MS) so opening Settings is cheap.
 * - `start()` runs scripts/update.sh <tag> as a live job: fast-forward the
 *   checkout to the tag, build, fetch the release APK, restart. Output is
 *   streamed via WS `update:state` and appended to <dataDir>/update.log.
 * - The script restarts the server as its last step, so a successful job
 *   ends with this process being replaced; the new process reports the new
 *   version and has no job.
 * - A packaged server (part of the desktop app bundle) never updates itself —
 *   the app brings the new server. It still reports the latest release (via
 *   `gh` or the public GitHub API), and a failed lookup stays quiet there:
 *   it is not something the user can act on from the server.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { UpdateInfo, UpdateJob } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import type { Broadcaster } from '../ws/gateway.js';
import { httpError } from '../http/errors.js';
import {
  fetchLatestRelease,
  fetchLatestReleasePackaged,
  isNewerRelease,
  type FetchRelease,
  type ReleaseInfo,
} from './release.js';

const CHECK_TTL_MS = 10 * 60_000;
const OUTPUT_CAP = 400;
const LINE_CAP = 2000;
const BROADCAST_INTERVAL_MS = 250;
export const UPDATE_TIMEOUT_MS = 20 * 60_000;

export interface UpdateChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): void;
  done: Promise<{ exitCode?: number; failed?: boolean }>;
}

/** Shown instead of the git message when the server ships inside the desktop app. */
export const PACKAGED_BLOCKED_REASON =
  'This server is part of the AgentDeck desktop app — update the app (Settings → Desktop).';

export type UpdateSpawn = (script: string, tag: string, env: Record<string, string>) => UpdateChild;

export interface UpdateManagerOptions {
  repoRoot: string;
  currentVersion: string;
  dataDir: string;
  /** Where this server answers locally — the script publishes the release APK there. */
  localUrl: string;
  log: Logger;
  broadcast: Broadcaster;
  /** Runs from the desktop app bundle: no self-update, release check without a checkout. */
  packaged?: boolean;
  fetchRelease?: FetchRelease;
  spawn?: UpdateSpawn;
}

export class UpdateManager {
  private readonly fetchRelease: FetchRelease;
  private readonly spawnFn: UpdateSpawn;
  private readonly script: string;
  private readonly logFile: string;
  private latest: ReleaseInfo | null = null;
  private checkedAt: number | undefined;
  private checkError: string | undefined;
  private checking: Promise<void> | undefined;
  private job: UpdateJob | undefined;
  private lastBroadcastAt = 0;
  private trailingTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: UpdateManagerOptions) {
    this.fetchRelease = opts.fetchRelease ?? (opts.packaged ? fetchLatestReleasePackaged : fetchLatestRelease);
    this.script = path.join(opts.repoRoot, 'scripts', 'update.sh');
    this.logFile = path.join(opts.dataDir, 'update.log');
    this.spawnFn =
      opts.spawn ??
      ((script, tag, env) => {
        const child = execa('bash', [script, tag], {
          cwd: opts.repoRoot,
          env: { ...process.env, ...env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          buffer: false,
          reject: false,
          // Own process group: the restart at the end must outlive this server.
          detached: true,
          cleanup: false,
        });
        return {
          stdout: child.stdout ?? null,
          stderr: child.stderr ?? null,
          kill: (signal) => {
            try {
              if (child.pid) process.kill(-child.pid, signal);
            } catch {
              // already gone
            }
          },
          done: child,
        };
      });
  }

  /** Why this install cannot update itself, if so. */
  private blockedReason(): string | undefined {
    if (this.opts.packaged) return PACKAGED_BLOCKED_REASON;
    if (!fs.existsSync(path.join(this.opts.repoRoot, '.git'))) {
      return 'This server does not run from a git checkout, so it cannot update itself.';
    }
    if (!fs.existsSync(this.script)) return 'scripts/update.sh is missing from this checkout.';
    return undefined;
  }

  private async check(): Promise<void> {
    try {
      this.latest = await this.fetchRelease(this.opts.repoRoot);
      this.checkError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.opts.packaged) {
        // Nothing the user could fix on the server (no gh, offline, rate limit) — no error banner.
        this.checkError = undefined;
        this.opts.log.debug?.({ err: message }, 'release check failed');
      } else {
        this.checkError = message;
      }
    }
    this.checkedAt = Date.now();
  }

  /** Current state; asks GitHub when the cached answer is stale (or `force`). */
  async info(force = false): Promise<UpdateInfo> {
    const stale = this.checkedAt === undefined || Date.now() - this.checkedAt > CHECK_TTL_MS;
    if (force || stale) {
      this.checking ??= this.check().finally(() => {
        this.checking = undefined;
      });
      await this.checking;
    }
    return this.snapshot();
  }

  snapshot(): UpdateInfo {
    const blocked = this.blockedReason();
    const latest = this.latest;
    return {
      current: this.opts.currentVersion,
      updateAvailable: latest !== null && isNewerRelease(latest.version, this.opts.currentVersion),
      ...(latest ? { latest: { ...latest } } : {}),
      ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(this.checkError ? { checkError: this.checkError } : {}),
      ...(blocked ? { blockedReason: blocked } : {}),
      ...(this.job ? { job: { ...this.job, output: [...this.job.output] } } : {}),
    };
  }

  /** Starts the update to the latest release. 409 while one runs or when there is nothing to do. */
  async start(): Promise<UpdateInfo> {
    if (this.job?.status === 'running') {
      throw httpError(409, 'UPDATE_RUNNING', 'An update is already running.');
    }
    const blocked = this.blockedReason();
    if (blocked) throw httpError(409, 'UPDATE_UNAVAILABLE', blocked);
    const info = await this.info(true);
    if (info.checkError) throw httpError(502, 'UPDATE_CHECK_FAILED', info.checkError);
    if (!info.updateAvailable || !info.latest) {
      throw httpError(409, 'UPDATE_NOT_NEEDED', `This server already runs the latest release (${info.current}).`);
    }
    const job: UpdateJob = { target: info.latest.version, status: 'running', output: [], startedAt: Date.now() };
    this.job = job;
    this.broadcast();
    void this.run(job, info.latest.tag);
    return this.snapshot();
  }

  /** Resolves when no update job is running and its log is written (tests). */
  async idle(): Promise<void> {
    await this.running;
    await this.logWrites;
  }

  private running: Promise<void> | undefined;

  private run(job: UpdateJob, tag: string): Promise<void> {
    this.running = (async () => {
      this.appendLog(`\n=== ${new Date().toISOString()} update ${this.opts.currentVersion} -> ${tag} ===`);
      let child: UpdateChild;
      try {
        child = this.spawnFn(this.script, tag, {
          // restart.sh restarts exactly this process, not "some AgentDeck server".
          AGENTDECK_SERVER_PID: String(process.pid),
          AGENTDECK_URL: this.opts.localUrl,
          AGENTDECK_DATA_DIR: this.opts.dataDir,
          AGENTDECK_UPDATE_LOG: this.logFile,
          NO_COLOR: '1',
        });
      } catch (err) {
        this.finish(job, `Could not start scripts/update.sh: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const timer = setTimeout(() => {
        job.error = `Timed out after ${Math.round(UPDATE_TIMEOUT_MS / 60_000)} min — update stopped`;
        child.kill('SIGTERM');
      }, UPDATE_TIMEOUT_MS);
      timer.unref?.();
      this.pipe(job, child.stdout);
      this.pipe(job, child.stderr);
      let result: { exitCode?: number; failed?: boolean };
      try {
        result = await child.done;
      } catch (err) {
        result = { failed: true };
        job.error ??= err instanceof Error ? err.message : String(err);
      }
      clearTimeout(timer);
      if (!job.error && (result.failed === true || (result.exitCode !== undefined && result.exitCode !== 0))) {
        job.error = `Update failed (exit code ${result.exitCode ?? 'signal'}) — the server keeps running the old version.`;
      }
      this.finish(job, job.error);
    })();
    return this.running;
  }

  private finish(job: UpdateJob, error?: string): void {
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    this.trailingTimer = undefined;
    job.endedAt = Date.now();
    job.status = error ? 'error' : 'done';
    if (error) {
      job.error = error;
      this.appendLog(`ERROR: ${error}`);
      this.opts.log.warn({ target: job.target, error }, 'server update failed');
    } else {
      this.opts.log.info({ target: job.target }, 'server update finished');
    }
    this.broadcast();
  }

  private pipe(job: UpdateJob, stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let buf = '';
    stream.setEncoding?.('utf8');
    const push = (line: string) => {
      job.output.push(line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line);
      while (job.output.length > OUTPUT_CAP) job.output.shift();
      this.appendLog(line);
      this.scheduleBroadcast(job);
    };
    stream.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const idx = buf.indexOf('\n');
        if (idx < 0) break;
        push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    stream.on('end', () => {
      if (buf.trim()) push(buf);
      buf = '';
    });
  }

  /** Appends are chained: lines land in order, and idle() can wait for them. */
  private logWrites: Promise<void> = Promise.resolve();

  private appendLog(line: string): void {
    this.logWrites = this.logWrites
      .then(() => fsp.appendFile(this.logFile, `${line}\n`, 'utf8'))
      .catch(() => undefined);
  }

  /** Leading + trailing edge throttle, like the admin job runner (~4/s). */
  private scheduleBroadcast(job: UpdateJob): void {
    if (job.status !== 'running') return;
    const elapsed = Date.now() - this.lastBroadcastAt;
    if (elapsed >= BROADCAST_INTERVAL_MS) {
      this.broadcast();
      return;
    }
    if (this.trailingTimer) return;
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = undefined;
      if (job.status === 'running') this.broadcast();
    }, BROADCAST_INTERVAL_MS - elapsed);
    this.trailingTimer.unref?.();
  }

  private broadcast(): void {
    this.lastBroadcastAt = Date.now();
    this.opts.broadcast('update:state', { update: this.snapshot() });
  }
}
