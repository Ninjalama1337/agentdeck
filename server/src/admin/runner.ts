/**
 * AdminJobRunner: executes the fixed agent administration recipes
 * (update / install / login) as live jobs — one at a time, globally.
 *
 * - spawns via execa (shell:false, reject:false, stdin ignored, output piped);
 *   interactive recipes (sign-ins) run in a pseudo-terminal instead and take
 *   input from the app, their terminal output is reduced to plain text
 * - splits stdout/stderr into lines → per-job 500-line ring buffer
 *   (each line capped at 2000 chars)
 * - broadcasts WS `admin:job` throttled to ~4/s (lines coalesce between
 *   ticks) plus one final broadcast when the job settles
 * - 30 min hard cap: SIGTERM → 3 s → SIGKILL → job status error
 * - after update/install (done OR error) re-detects the agent so a fresh
 *   AgentInfo is broadcast, then emits a `notify` toast
 * - keeps the last 20 finished jobs in memory (newest first)
 */
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { AGENT_LABELS, type AdminJob, type AdminJobKind, type AgentId } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import type { AgentService } from '../agents/registry.js';
import type { Broadcaster } from '../ws/gateway.js';
import { httpError } from '../http/errors.js';
import { newAdminJobId } from '../util/ids.js';
import { pty } from '../term/pty.js';
import { augmentedPath, findExecutable } from '../term/presets.js';
import type { AdminRecipe } from './recipes.js';

export const ADMIN_JOB_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_CAP = 500;
const LINE_CAP = 2000;
const HISTORY_CAP = 20;
const BROADCAST_INTERVAL_MS = 250; // ≈ 4 broadcasts/s per job
const KILL_GRACE_MS = 3000;
/** Wide enough that a sign-in URL is never wrapped across lines. */
const PTY_COLS = 1000;
const PTY_ROWS = 50;
/** A prompt has no trailing newline — show it once the output goes quiet. */
const PARTIAL_LINE_FLUSH_MS = 300;
/** Gap between typed text and Enter, so a TUI does not swallow it as a paste. */
const INPUT_ENTER_DELAY_MS = 120;

/** Exec result shape (satisfied by execa with reject:false). */
export interface AdminSpawnResult {
  exitCode?: number;
  failed?: boolean;
}

/** Minimal child-process surface the runner needs (fake-able in tests). */
export interface AdminChild {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): void;
  /** Types into the process; only present when it runs in a pseudo-terminal. */
  write?(data: string): void;
  done: Promise<AdminSpawnResult>;
}

export type AdminSpawn = (recipe: AdminRecipe) => AdminChild;

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  // The child was spawned detached → it leads its own process group.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // fall back to the direct pid
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Terminal output → plain lines: cursor-forward becomes spaces (TUIs use it
 * instead of blanks), colors vanish, every other cursor move starts a new line.
 */
export function plainTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_match, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/\r/g, '\n');
}

function spawnInPty(recipe: AdminRecipe): AdminChild {
  const env = { ...process.env, ...recipe.envAdd } as Record<string, string>;
  const file = findExecutable(recipe.command, augmentedPath(env.PATH));
  if (!file) throw new Error(`${recipe.command} not found on PATH`);
  const term = pty.spawn(file, recipe.args, {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: recipe.cwd,
    env,
  });
  const stdout = new PassThrough();
  term.onData((data) => stdout.write(data));
  const done = new Promise<AdminSpawnResult>((resolve) => {
    term.onExit(({ exitCode }) => {
      stdout.end();
      resolve({ exitCode, failed: exitCode !== 0 });
    });
  });
  return {
    pid: term.pid,
    stdout,
    stderr: null,
    kill: (signal) => killTree(term.pid, signal),
    write: (data) => term.write(data),
    done,
  };
}

const defaultSpawn: AdminSpawn = (recipe) => {
  if (recipe.interactive) return spawnInPty(recipe);
  const child = execa(recipe.command, recipe.args, {
    cwd: recipe.cwd,
    env: { ...process.env, ...recipe.envAdd },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    detached: true,
    cleanup: false,
  });
  return {
    pid: child.pid,
    stdout: child.stdout ?? null,
    stderr: child.stderr ?? null,
    kill: (signal) => killTree(child.pid, signal),
    done: child,
  };
};

export interface AdminJobRunnerOptions {
  agents: Pick<AgentService, 'redetect'>;
  log: Logger;
  broadcast: Broadcaster;
  /** Spawn override (tests). */
  spawn?: AdminSpawn;
  /** Hard cap per job (tests); default 30 min. */
  timeoutMs?: number;
}

interface InternalJob extends AdminJob {
  timeoutHit?: boolean;
  stopReason?: string;
  userStopped?: boolean;
  lastBroadcastAt?: number;
  trailingTimer?: NodeJS.Timeout;
}

export class AdminJobRunner {
  private readonly spawnFn: AdminSpawn;
  private readonly timeoutMs: number;
  private readonly history: InternalJob[] = [];
  private active: InternalJob | undefined;
  private current: Promise<void> | undefined;

  constructor(private readonly opts: AdminJobRunnerOptions) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.timeoutMs = opts.timeoutMs ?? ADMIN_JOB_TIMEOUT_MS;
  }

  /** Finished + running jobs, newest first (capped, in-memory). */
  list(): AdminJob[] {
    return this.history.map((job) => this.snapshot(job));
  }

  get(id: string): AdminJob | undefined {
    const job = this.history.find((j) => j.id === id);
    return job ? this.snapshot(job) : undefined;
  }

  /**
   * Starts a recipe. Throws 409 ADMIN_JOB_ACTIVE while another job runs;
   * starting is possible again as soon as the previous job is done/error.
   */
  start(agentId: AgentId, kind: AdminJobKind, recipe: AdminRecipe): AdminJob {
    if (this.active) {
      throw httpError(
        409,
        'ADMIN_JOB_ACTIVE',
        `An admin job is already running (${this.active.agentId} ${this.active.kind}) — try again when it finishes.`,
      );
    }
    const job: InternalJob = {
      id: newAdminJobId(),
      agentId,
      kind,
      status: 'queued',
      output: [],
      startedAt: Date.now(),
      ...(recipe.interactive ? { interactive: true } : {}),
    };
    this.history.unshift(job);
    if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
    this.active = job;
    const spawned = this.snapshot(job);
    // Runs asynchronously; start() stays synchronous so REST can 202 immediately.
    this.current = this.run(job, recipe).catch((err) => {
      this.opts.log.error({ err, job: job.id }, 'admin job crashed');
      this.finish(job, { exitCode: undefined, failed: true }, err instanceof Error ? err.message : String(err));
    });
    return spawned;
  }

  /** Resolves when no admin job is running anymore (tests / shutdown). */
  async idle(): Promise<void> {
    await this.current;
  }

  /** Kills the active job (SIGTERM → 3 s → SIGKILL). Used on app close. */
  stop(reason = 'Server shutting down'): boolean {
    if (!this.active) return false;
    this.active.stopReason = reason;
    this.killActive('SIGTERM');
    this.opts.log.info({ job: this.active.id }, 'stopping admin job');
    return true;
  }

  /** User-initiated cancel of the ACTIVE job → status 'stopped' (not error). */
  stopJob(id: string): boolean {
    if (!this.active || this.active.id !== id) return false;
    this.active.userStopped = true;
    return this.stop('Cancelled from the app');
  }

  /**
   * Types one line into the ACTIVE interactive job (the pasted sign-in code).
   * False when the job is not running or takes no input.
   */
  input(id: string, text: string): boolean {
    const child = this.child;
    if (!this.active || this.active.id !== id || !child?.write) return false;
    child.write(text);
    const enter = setTimeout(() => {
      if (this.child === child) child.write?.('\r');
    }, INPUT_ENTER_DELAY_MS);
    enter.unref?.();
    return true;
  }

  // ---------------------------------------------------------------------------

  private killActive(signal: NodeJS.Signals): void {
    const child = this.child;
    child?.kill(signal);
    const killTimer = setTimeout(() => {
      if (this.active) child?.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  }

  private child: AdminChild | undefined;

  private async run(job: InternalJob, recipe: AdminRecipe): Promise<void> {
    job.status = 'running';
    this.broadcast(job);

    let child: AdminChild;
    try {
      child = this.spawnFn(recipe);
    } catch (err) {
      this.finish(job, { exitCode: undefined, failed: true }, `Failed to spawn ${recipe.command}: ${errorMessage(err)}`);
      return;
    }
    this.child = child;

    const timer = setTimeout(() => {
      job.timeoutHit = true;
      job.stopReason = `Timed out after ${Math.round(this.timeoutMs / 60_000)} min — process killed`;
      this.killActive('SIGTERM');
    }, this.timeoutMs);
    timer.unref?.();

    this.pipe(job, child.stdout);
    this.pipe(job, child.stderr);

    let result: AdminSpawnResult;
    let doneError: string | undefined;
    try {
      result = await child.done;
    } catch (err) {
      result = { exitCode: undefined, failed: true };
      doneError = errorMessage(err);
    }
    clearTimeout(timer);
    if (job.trailingTimer) clearTimeout(job.trailingTimer);
    this.child = undefined;

    if (job.stopReason) {
      this.finish(job, result, job.stopReason);
      return;
    }
    if (doneError) {
      this.finish(job, result, doneError);
      return;
    }
    const code = result.exitCode;
    if (result.failed === true || (code !== undefined && code !== 0)) {
      this.finish(
        job,
        result,
        `${AGENT_LABELS[job.agentId]} ${recipe.label} failed with exit code ${code ?? 'signal'}`,
      );
      return;
    }
    try {
      recipe.onSuccess?.();
    } catch (err) {
      this.opts.log.warn({ err, job: job.id }, 'admin job follow-up failed');
    }
    this.finish(job, result);
  }

  /** Settles the job, does the final broadcast and the update/install aftermath. */
  private finish(job: InternalJob, result: AdminSpawnResult, error?: string): void {
    if (this.active === job) this.active = undefined;
    job.exitCode = result.exitCode;
    job.endedAt = Date.now();
    if (error) job.error = error;
    job.status = error ? (job.userStopped ? 'stopped' : 'error') : 'done';
    this.broadcast(job);

    if (job.kind === 'update' || job.kind === 'install') {
      // Even a failed install may have changed the installation — re-detect.
      void this.afterDetect(job);
    }
  }

  private async afterDetect(job: InternalJob): Promise<void> {
    try {
      await this.opts.agents.redetect(job.agentId);
    } catch (err) {
      this.opts.log.warn({ err, job: job.id }, 'post-job re-detection failed');
    }
    this.opts.broadcast('notify', {
      level: job.status === 'done' ? 'info' : 'error',
      text: `${AGENT_LABELS[job.agentId]} ${job.kind} finished`,
    });
  }

  /** Splits a stream into lines and pushes them into the job ring buffer. */
  private pipe(job: InternalJob, stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let buf = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const push = (line: string) => {
      if (job.interactive) this.pushTerminalText(job, line);
      else this.pushLine(job, line);
    };
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const idx = buf.indexOf('\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        push(line);
      }
      if (!job.interactive) return;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (buf.trim()) push(buf);
        buf = '';
      }, PARTIAL_LINE_FLUSH_MS);
      flushTimer.unref?.();
    });
    stream.on('end', () => {
      if (flushTimer) clearTimeout(flushTimer);
      if (buf.trim()) push(buf);
      buf = '';
    });
  }

  /** Terminal output: plain text only, no decoration lines, no redraw repeats. */
  private pushTerminalText(job: InternalJob, raw: string): void {
    for (const part of plainTerminalText(raw).split('\n')) {
      const line = part.trim();
      if (!/[\p{L}\p{N}]/u.test(line)) continue;
      if (job.output.includes(line, Math.max(0, job.output.length - 8))) continue;
      this.pushLine(job, line);
    }
  }

  private pushLine(job: InternalJob, line: string): void {
    const trimmed = line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line;
    job.output.push(trimmed);
    while (job.output.length > OUTPUT_CAP) job.output.shift();
    this.scheduleBroadcast(job);
  }

  /**
   * Leading + trailing edge throttle: emit immediately after a quiet period,
   * coalesce lines in between, never more than ~4/s per job.
   */
  private scheduleBroadcast(job: InternalJob): void {
    if (job.status !== 'running') return; // settled jobs get their final broadcast in finish()
    const now = Date.now();
    const last = job.lastBroadcastAt ?? 0;
    const elapsed = now - last;
    if (elapsed >= BROADCAST_INTERVAL_MS) {
      job.lastBroadcastAt = now;
      this.broadcast(job);
      return;
    }
    if (job.trailingTimer) return;
    job.trailingTimer = setTimeout(() => {
      job.trailingTimer = undefined;
      if (job.status !== 'running') return;
      job.lastBroadcastAt = Date.now();
      this.broadcast(job);
    }, BROADCAST_INTERVAL_MS - elapsed);
    job.trailingTimer.unref?.();
  }

  private broadcast(job: InternalJob): void {
    this.opts.broadcast('admin:job', { job: this.snapshot(job) });
  }

  private snapshot(job: InternalJob): AdminJob {
    return {
      id: job.id,
      agentId: job.agentId,
      kind: job.kind,
      status: job.status,
      output: [...job.output],
      startedAt: job.startedAt,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.interactive ? { interactive: true } : {}),
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
