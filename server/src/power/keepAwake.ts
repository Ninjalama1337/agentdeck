/**
 * Keeps the computer awake while agents work (after Orca's "caffeinate"): a
 * machine that suspends mid-run stops every agent and cuts the phone off.
 *
 * While something is busy an inhibitor process holds the lock —
 * `systemd-inhibit … sleep infinity` on Linux, `caffeinate -i` on macOS — and
 * it is released a grace period after the last work ended. The switch is kept
 * in the data dir (`power.json`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { PowerStatus } from '@agentdeck/shared';

export const KEEP_AWAKE_TICK_MS = 30_000;
/** Stay awake this long after the last work — the next prompt usually follows. */
export const KEEP_AWAKE_GRACE_MS = 3 * 60_000;

export interface InhibitorCommand {
  command: string;
  args: string[];
}

/** How this platform holds the lock, or null when it cannot. */
export function inhibitorFor(platform: NodeJS.Platform, has: (bin: string) => boolean): InhibitorCommand | null {
  if (platform === 'linux' && has('systemd-inhibit')) {
    return {
      command: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=AgentDeck', '--why=Agents are working', '--mode=block', 'sleep', 'infinity'],
    };
  }
  if (platform === 'darwin' && has('caffeinate')) return { command: 'caffeinate', args: ['-i'] };
  return null;
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true;
  }
  return ['/usr/bin', '/bin', '/usr/sbin'].some((d) => fs.existsSync(path.join(d, bin)));
}

export interface KeepAwakeOptions {
  dataDir: string;
  /** What keeps the machine busy right now ("2 agents", or null when idle). */
  busy(): string | null;
  log: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  inhibitor?: InhibitorCommand | null;
  spawnProcess?: (cmd: string, args: string[]) => ChildProcess;
  now?: () => number;
}

export class KeepAwake {
  private enabled = true;
  private child: ChildProcess | null = null;
  private since: number | null = null;
  private lastBusy = 0;
  private reason: string | null = null;
  private error: string | null = null;
  /** A refused lock is not asked for again right away. */
  private failedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly inhibitor: InhibitorCommand | null;
  private readonly file: string;

  constructor(private readonly opts: KeepAwakeOptions) {
    this.inhibitor = opts.inhibitor !== undefined ? opts.inhibitor : inhibitorFor(process.platform, onPath);
    this.file = path.join(opts.dataDir, 'power.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { keepAwake?: unknown };
      if (typeof saved.keepAwake === 'boolean') this.enabled = saved.keepAwake;
    } catch {
      /* default: on */
    }
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(): void {
    if (this.timer || !this.inhibitor) return;
    this.timer = setInterval(() => this.tick(), KEEP_AWAKE_TICK_MS);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.release();
  }

  setEnabled(enabled: boolean): PowerStatus {
    this.enabled = enabled;
    this.failedAt = 0;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ keepAwake: enabled }));
    } catch (err) {
      this.opts.log.warn({ err }, 'cannot save power settings');
    }
    this.tick();
    return this.status();
  }

  status(): PowerStatus {
    return {
      supported: this.inhibitor !== null,
      enabled: this.enabled,
      active: this.child !== null,
      ...(this.since !== null ? { since: this.since } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  tick(): void {
    const busy = this.opts.busy();
    if (busy) {
      this.lastBusy = this.now;
      this.reason = busy;
    }
    const want = this.enabled && this.inhibitor !== null && (busy !== null || this.now - this.lastBusy < KEEP_AWAKE_GRACE_MS) && this.lastBusy > 0;
    if (want && !this.child && this.now - this.failedAt > 10 * 60_000) this.hold();
    else if (!want && this.child) this.release();
  }

  private hold(): void {
    const inh = this.inhibitor!;
    try {
      const child = (this.opts.spawnProcess ?? ((c, a) => spawn(c, a, { stdio: ['ignore', 'ignore', 'pipe'] })))(inh.command, inh.args);
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        this.error = err.message;
        if (this.child === child) this.child = null;
      });
      child.on('exit', (code) => {
        if (this.child !== child) return;
        // It ended on its own: refused by the system (polkit) or killed from outside.
        this.child = null;
        this.since = null;
        if (code) {
          this.error = stderr.trim().slice(0, 300) || `${inh.command} exited with ${code}`;
          this.failedAt = this.now;
        }
      });
      this.child = child;
      this.since = this.now;
      this.error = null;
      this.opts.log.info({ reason: this.reason }, 'keeping the computer awake while agents work');
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private release(): void {
    const child = this.child;
    this.child = null;
    this.since = null;
    if (child) {
      child.kill();
      this.opts.log.info({}, 'agents idle — the computer may sleep again');
    }
  }
}
