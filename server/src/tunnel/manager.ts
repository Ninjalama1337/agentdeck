/**
 * TunnelManager: runs a cloudflared tunnel for secure remote access.
 *
 * - quick mode: `cloudflared tunnel --url http://127.0.0.1:<port>` → the
 *   random https://<name>.trycloudflare.com URL is parsed from stderr.
 * - token mode: `cloudflared tunnel run --token <token>` (named tunnel);
 *   the public URL is the configured hostname, status flips to connected
 *   once the process stays alive past the grace period after a
 *   "Registered tunnel connection" log line.
 *
 * Fully lazy and crash-safe: the server listens before start() is called,
 * and cloudflared failures never propagate. Crashes auto-restart with a
 * capped backoff (1s, 2s, 5s, 10s, 30s max — reset after 60s stable);
 * after MAX_RESTARTS the manager gives up with status "error".
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { TunnelInfo } from '@agentdeck/shared';
import type { ResolvedTunnelConfig } from '../config.js';
import type { Logger } from '../logging.js';
import { ensureDir } from '../util/paths.js';

type Child = ReturnType<typeof execa>;

/** Install hint included in every "binary missing" message. */
export const CLOUDFLARED_INSTALL_HINT =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

/** Matches the quick-tunnel URL cloudflared prints to stderr. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.trycloudflare\.com/;

/** cloudflared logs this when a tunnel connection registered at the edge. */
const REGISTERED_RE = /Registered tunnel connection/;

/** Capped restart backoff schedule (ms), by consecutive-restart index. */
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const MAX_RESTARTS = 10;
/** A child that lived at least this long counts as "stable" and resets the backoff. */
export const STABLE_AFTER_MS = 60_000;
/** Token mode: grace period after "Registered tunnel connection" before "connected". */
const TOKEN_CONNECTED_GRACE_MS = 2_000;
const STOP_GRACE_MS = 3_000;

/** Extracts a trycloudflare.com URL from any cloudflared output chunk (JSON logs, plain lines, banner boxes). */
export function extractTunnelUrl(text: string): string | undefined {
  return TRYCLOUDFLARE_RE.exec(text)?.[0];
}

/** True when the output contains cloudflared's registration confirmation. */
export function sawRegisteredConnection(text: string): boolean {
  return REGISTERED_RE.test(text);
}

/** Backoff before the next restart (0-indexed consecutive-restart counter). */
export function nextRestartDelayMs(consecutiveRestarts: number): number {
  const idx = Math.min(Math.max(consecutiveRestarts, 0), RESTART_DELAYS_MS.length - 1);
  return RESTART_DELAYS_MS[idx] as number;
}

/** True when the process lived long enough to reset the restart counter. */
export function wasStable(startedAtMs: number, exitedAtMs: number): boolean {
  return exitedAtMs - startedAtMs >= STABLE_AFTER_MS;
}

export function cloudflaredArgs(tunnel: ResolvedTunnelConfig, upstreamPort: number): string[] {
  // NOTE: `tunnel run` accepts neither --no-autoupdate nor --hostname
  // (verified against cloudflared 2026.9.1) — ingress for dashboard-managed
  // (token) tunnels comes from the dashboard; for named tunnels we point the
  // tunnel at the local server via --url, DNS routing was set up beforehand.
  if (tunnel.mode === 'token') {
    return ['tunnel', 'run', '--token', tunnel.token];
  }
  if (tunnel.mode === 'named') {
    const args = ['tunnel', 'run', '--url', `http://127.0.0.1:${upstreamPort}`];
    if (tunnel.credentialsFile.trim()) args.push('--cred-file', tunnel.credentialsFile.trim());
    args.push(tunnel.name.trim());
    return args;
  }
  return ['tunnel', '--url', `http://127.0.0.1:${upstreamPort}`, '--no-autoupdate'];
}

export type NotifyFn = (level: 'info' | 'warn' | 'error', text: string) => void;

export interface TunnelManagerOptions {
  tunnel: ResolvedTunnelConfig;
  dataDir: string;
  logger: Logger;
  /** Wired to the socket.io notify broadcast by the app layer. */
  notify?: NotifyFn;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface SpawnOutcome {
  child?: Child;
  /** Spawn-level failure (e.g. binary missing) — never retried. */
  spawnError?: Error;
}

export class TunnelManager {
  private readonly tunnel: ResolvedTunnelConfig;
  private readonly dataDir: string;
  private readonly logger: Logger;
  private readonly notify?: NotifyFn;
  private readonly now: () => number;

  private status: TunnelInfo['status'];
  private publicUrl?: string;
  private error?: string;

  private child?: Child;
  private upstreamPort = 0;
  private started = false;
  private stopping = false;
  private spawnOk = false;
  private startedAt = 0;
  private consecutiveRestarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private outputBuf = '';
  private registered = false;
  private announcedUrl?: string;

  constructor(opts: TunnelManagerOptions) {
    this.tunnel = opts.tunnel;
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.notify = opts.notify;
    this.now = opts.now ?? Date.now;
    this.status = opts.tunnel.provider === 'off' ? 'disabled' : 'starting';
  }

  getInfo(): TunnelInfo {
    return {
      provider: this.tunnel.provider,
      status: this.status,
      ...(this.publicUrl ? { publicUrl: this.publicUrl } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Compact shape for /api/health (only called when provider != off). */
  healthInfo(): { status: TunnelInfo['status']; publicUrl?: string } {
    return {
      status: this.status,
      ...(this.publicUrl ? { publicUrl: this.publicUrl } : {}),
    };
  }

  /**
   * Starts cloudflared in the background (never throws). Safe to call once;
   * the server should already be listening on `upstreamPort`.
   */
  start(upstreamPort: number): void {
    if (this.tunnel.provider === 'off' || this.started) return;
    this.started = true;
    this.upstreamPort = upstreamPort;
    this.error = undefined;
    void this.launch();
  }

  /** Stops the tunnel (SIGTERM → 3 s → SIGKILL) and cancels pending restarts. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.connectTimer);
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined;
      if (this.started) this.status = 'disabled';
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, STOP_GRACE_MS);
    killTimer.unref?.();
    const raced = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, STOP_GRACE_MS + 1_000);
      t.unref?.();
    });
    await Promise.race([exited, raced]);
    clearTimeout(killTimer);
    this.child = undefined;
    this.status = 'disabled';
  }

  // -------------------------------------------------------------------------

  private spawnCloudflared(args: string[]): SpawnOutcome {
    try {
      const child = execa(this.tunnel.binary, args, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false,
        reject: false,
        cleanup: true,
        detached: false,
      });
      return { child };
    } catch (err) {
      return { spawnError: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    this.spawnOk = false;
    this.publicUrl = undefined;
    this.registered = false;
    this.outputBuf = '';
    this.status = 'starting';
    this.error = undefined;

    const { child, spawnError } = this.spawnCloudflared(cloudflaredArgs(this.tunnel, this.upstreamPort));
    if (spawnError || !child) {
      this.onSpawnFailure(spawnError ?? new Error('failed to spawn cloudflared'));
      return;
    }
    this.child = child;
    // With reject:false execa settles instead of rejecting; still guard it.
    child.catch(() => undefined);

    child.once('spawn', () => {
      this.spawnOk = true;
      this.startedAt = this.now();
      this.logger.info({ mode: this.tunnel.mode }, 'cloudflared spawned');
    });
    child.once('error', (err: Error) => {
      if (this.spawnOk) {
        this.logger.error({ err }, 'cloudflared runtime error');
      } else {
        this.onSpawnFailure(err);
      }
    });
    child.once('close', (code: number | null, signal: string | null) => {
      if (this.spawnOk) this.onChildExit(code, signal);
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onOutput(chunk));
    child.stderr?.on('data', (chunk: string) => this.onOutput(chunk));
  }

  private onSpawnFailure(err: Error): void {
    if (this.stopping) return;
    this.child = undefined;
    const missing =
      (err as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT|not found/i.test(err.message);
    this.status = 'error';
    this.error = missing
      ? `cloudflared binary not found ("${this.tunnel.binary}"). Install it from ${CLOUDFLARED_INSTALL_HINT} or set tunnel.binary / AGENTDECK_TUNNEL_BINARY.`
      : `cloudflared failed to start: ${err.message}`;
    this.logger.error({ err }, 'cloudflared failed to start');
    this.notify?.('error', missing ? 'Tunnel offline: cloudflared is not installed.' : 'Tunnel failed to start.');
    // A missing binary will not fix itself — do not hot-loop restarts.
  }

  private onOutput(chunk: string): void {
    this.outputBuf = (this.outputBuf + chunk).slice(-200_000);
    if (!this.registered && sawRegisteredConnection(chunk)) {
      this.registered = true;
      if (this.tunnel.mode === 'token' || this.tunnel.mode === 'named') {
        // Connected once the process stays alive past the grace period.
        clearTimeout(this.connectTimer);
        this.connectTimer = setTimeout(() => {
          if (this.child && !this.stopping && this.status !== 'connected') {
            this.setConnected(this.tunnel.hostname.trim() ? `https://${this.tunnel.hostname.trim()}` : undefined);
          }
        }, TOKEN_CONNECTED_GRACE_MS);
        this.connectTimer.unref?.();
      }
    }
    if (this.status !== 'connected' && this.tunnel.mode === 'quick') {
      const url = extractTunnelUrl(this.outputBuf);
      if (url) this.setConnected(url);
    }
  }

  private setConnected(publicUrl: string | undefined): void {
    this.status = 'connected';
    this.consecutiveRestarts = 0;
    this.error = undefined;
    if (publicUrl) this.publicUrl = publicUrl;
    this.logger.info({ url: this.publicUrl ?? '(configured hostname)' }, 'tunnel connected');
    if (this.publicUrl && this.announcedUrl !== this.publicUrl) {
      this.announcedUrl = this.publicUrl;
      void this.announce(this.publicUrl);
    }
    if (!this.publicUrl) this.notify?.('info', 'Tunnel live.');
  }

  private async announce(url: string): Promise<void> {
    this.notify?.('info', `Tunnel live: ${url}`);
    try {
      await ensureDir(this.dataDir);
      await fsp.writeFile(path.join(this.dataDir, 'tunnel-url.txt'), url + '\n', 'utf8');
    } catch (err) {
      this.logger.warn({ err }, 'failed to write tunnel-url.txt');
    }
    try {
      const qrcode = await import('qrcode-terminal');
      // The QR opens the app AND re-points it to this tunnel via ?server=
      // (no manual URL typing after a quick-tunnel URL rotation).
      const connectUrl = `${url}/?server=${encodeURIComponent(url)}`;
      qrcode.default.generate(connectUrl, { small: true }, (qr: string) => {
        // eslint-disable-next no-console
        console.log(
          `\n  Tunnel: ${url}\n  Scan to open the app already pointed at this tunnel\n  (or open manually): ${connectUrl}\n${qr
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n')}\n`,
        );
      });
    } catch {
      // QR is cosmetic — ignore.
    }
  }

  private onChildExit(code: number | null, signal: string | null): void {
    this.child = undefined;
    clearTimeout(this.connectTimer);
    if (this.stopping) {
      this.status = 'disabled';
      return;
    }
    const exitedAt = this.now();
    if (this.startedAt > 0 && wasStable(this.startedAt, exitedAt)) {
      this.consecutiveRestarts = 0;
    }
    if (this.consecutiveRestarts >= MAX_RESTARTS) {
      this.status = 'error';
      this.error = `cloudflared exited ${MAX_RESTARTS + 1} times in a row (last: code=${code ?? '-'} signal=${signal ?? '-'})${this.lastOutputLine() ? ` — ${this.lastOutputLine()}` : ''} — giving up.`;
      this.logger.error({ code, signal, lastOutput: this.lastOutputLine() }, 'cloudflared keeps crashing; tunnel disabled');
      this.notify?.('error', 'Tunnel offline: cloudflared keeps crashing.');
      return;
    }
    const delay = nextRestartDelayMs(this.consecutiveRestarts);
    this.consecutiveRestarts += 1;
    this.status = 'starting';
    this.logger.warn(
      { code, signal, restartIn: delay, attempt: this.consecutiveRestarts, lastOutput: this.lastOutputLine() },
      'cloudflared exited; restarting',
    );
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) void this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Last non-empty cloudflared output line — surfaces the actual CLI error. */
  private lastOutputLine(): string {
    const lines = this.outputBuf
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
  }
}
