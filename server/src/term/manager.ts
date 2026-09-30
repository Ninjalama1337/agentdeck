/**
 * TerminalManager: real PTY shells ("Code" tab), project-scoped.
 *
 * - spawns $SHELL (fallback /bin/bash) in the project path via node-pty
 * - optionally types a launch command (agent TUI preset) into the fresh shell
 * - streams UTF-8 chunks to every authed client (single-user deck)
 * - detects "needs attention" (bell, OSC 9/777 notifications, quiet after work)
 * - caps concurrency, reaps idle terminals, kills everything on shutdown
 */
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { pty } from './pty.js';
import type { TerminalInfo } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { newTerminalId } from '../util/ids.js';
import { augmentedPath } from './presets.js';
import { AttentionDetector, type AttentionReason } from './attention.js';

export interface TerminalBroadcasts {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  onList: () => void;
  /** Terminal wants the user (bell / notification / finished work). */
  onAttention?: (info: TerminalInfo, reason: AttentionReason, text?: string) => void;
}

export interface SpawnOptions {
  title?: string;
  presetId?: string;
  variantId?: string;
  /** Run inside the login shell right after spawn (agent TUI, dev server …). */
  command?: string;
  /** Report "quiet after work" (agent TUIs); bell/OSC notifications always count. */
  idleNotify?: boolean;
}

interface ActiveTerminal {
  info: TerminalInfo;
  proc: import('node-pty').IPty;
  idleTimer: NodeJS.Timeout;
  /**
   * Server-side terminal emulator mirroring the PTY. It answers terminal
   * queries (cursor position, colors) even when no phone is attached and
   * serializes a clean screen snapshot for (re)connecting clients.
   */
  screen: InstanceType<typeof xtermHeadless.Terminal>;
  serializer: InstanceType<typeof serializeAddon.SerializeAddon>;
  attention: AttentionDetector;
}

const MAX_CONCURRENT = 10;
/** Agent TUIs sit silently for hours while you are away — reap only truly dead shells. */
const IDLE_MS = 12 * 60 * 60_000;
const SCROLLBACK = 3000;
const REPLAY_SCROLLBACK = 1500;

/** Server env minus npm-run noise (npm_config_prefix breaks nvm in the shell). */
function shellEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return env;
}

/** argv that runs `command` in an interactive login shell, then stays in a shell. */
export function shellArgsFor(shell: string, command: string): string[] {
  // bash, zsh and fish all accept `-l -i -c <script>`.
  const quoted = `'${shell.replace(/'/g, "'\\''")}'`;
  // `clear` first: the login banner (motd, fastfetch) is noise above a TUI.
  return ['-l', '-i', '-c', `clear 2>/dev/null; ${command}; exec ${quoted} -l`];
}

export class TerminalManager {
  private readonly active = new Map<string, ActiveTerminal>();

  constructor(private readonly log: Logger) {}

  list(projectId?: string): TerminalInfo[] {
    const all = [...this.active.values()].map((t) => t.info);
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }

  get(id: string): { info: TerminalInfo; replay: string } | undefined {
    const t = this.active.get(id);
    return t ? { info: t.info, replay: this.snapshot(t) } : undefined;
  }

  /** Serialized screen + scrollback — used when a client (re)attaches. */
  replayOf(id: string): string | undefined {
    const t = this.active.get(id);
    return t ? this.snapshot(t) : undefined;
  }

  private snapshot(t: ActiveTerminal): string {
    try {
      return t.serializer.serialize({ scrollback: REPLAY_SCROLLBACK });
    } catch {
      return '';
    }
  }

  spawn(
    projectPath: string,
    projectId: string,
    cols: number,
    rows: number,
    broadcast: TerminalBroadcasts,
    opts: SpawnOptions = {},
  ): TerminalInfo {
    if (this.active.size >= MAX_CONCURRENT) {
      // Reap the oldest terminal instead of refusing — phone users churn tabs.
      const oldest = [...this.active.values()].sort((a, b) => a.info.createdAt - b.info.createdAt)[0];
      if (oldest) this.kill(oldest.info.id, broadcast);
    }
    const id = newTerminalId();
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/bash';
    const info: TerminalInfo = {
      id,
      projectId,
      createdAt: Date.now(),
      cols,
      rows,
      title: opts.title ?? 'shell',
      presetId: opts.presetId ?? 'shell',
      ...(opts.variantId ? { variantId: opts.variantId } : {}),
      ...(opts.command ? { command: opts.command } : {}),
    };
    // A launch command runs inside an interactive login shell (rc files,
    // aliases, PATH) and drops back into a fresh shell when the TUI exits —
    // passing it as an argument avoids racing rc scripts that query the
    // terminal on startup (typed input would be swallowed by those reads).
    const args = opts.command ? shellArgsFor(shell, opts.command) : ['-l'];
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: projectPath,
      env: {
        ...shellEnv(),
        PATH: augmentedPath(process.env.PATH),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENTDECK_PROJECT: path.basename(projectPath),
      } as Record<string, string>,
    });
    const screen = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new serializeAddon.SerializeAddon();
    screen.loadAddon(serializer);
    // Query responses (DSR, DA, OSC 10/11) go straight back into the PTY.
    screen.onData((reply) => {
      try {
        proc.write(reply);
      } catch {
        // pty gone
      }
    });
    const term: ActiveTerminal = {
      info,
      proc,
      screen,
      serializer,
      idleTimer: this.armIdleTimer(id, broadcast),
      attention: new AttentionDetector({
        // "Quiet after work" only makes sense for agent TUIs; a plain shell
        // going quiet after `ls` is not news.
        idleNotify: opts.idleNotify === true,
        onAttention: (reason, text) => {
          if (this.active.get(id) !== term) return;
          const changed = !term.info.attention;
          term.info.attention = true;
          broadcast.onAttention?.(term.info, reason, text);
          if (changed) broadcast.onList();
        },
      }),
    };
    this.active.set(id, term);
    proc.onData((data) => {
      term.screen.write(data);
      term.info.lastOutputAt = Date.now();
      term.attention.output(data);
      this.touchIdle(term, id, broadcast);
      broadcast.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(term.idleTimer);
      term.attention.dispose();
    term.screen.dispose();
      // An explicit kill() already removed+broadcast this terminal — only
      // natural exits (user typed `exit`) run the cleanup path.
      if (this.active.get(id) !== term) return;
      this.active.delete(id);
      this.log.info({ terminal: id, code: exitCode }, 'terminal exited');
      broadcast.onExit(id, exitCode);
      broadcast.onList();
    });
    this.log.info({ terminal: id, projectId, shell }, 'terminal spawned');
    broadcast.onList();
    return info;
  }

  write(id: string, data: string): boolean {
    const term = this.active.get(id);
    if (!term) return false;
    try {
      term.proc.write(data);
      term.attention.input();
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const term = this.active.get(id);
    if (!term) return false;
    const c = Math.min(Math.max(10, Math.round(cols)), 500);
    const r = Math.min(Math.max(4, Math.round(rows)), 300);
    try {
      term.proc.resize(c, r);
      term.screen.resize(c, r);
      term.info.cols = c;
      term.info.rows = r;
      return true;
    } catch {
      return false;
    }
  }

  /** The user looked at the terminal — clear its attention flag. */
  markSeen(id: string, broadcast: TerminalBroadcasts): void {
    const term = this.active.get(id);
    if (!term || !term.info.attention) return;
    term.info.attention = false;
    broadcast.onList();
  }

  kill(id: string, broadcast: TerminalBroadcasts): boolean {
    const term = this.active.get(id);
    if (!term) return false;
    term.attention.dispose();
    term.screen.dispose();
    // Remove synchronously so spawn's reap-oldest logic sees the free slot
    // immediately (proc.onExit arrives asynchronously otherwise).
    clearTimeout(term.idleTimer);
    this.active.delete(id);
    try {
      term.proc.kill();
    } catch {
      // already gone
    }
    this.log.info({ terminal: id }, 'terminal killed');
    broadcast.onExit(id, -1);
    broadcast.onList();
    return true;
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) {
      const term = this.active.get(id);
      if (!term) continue;
      clearTimeout(term.idleTimer);
      term.attention.dispose();
    term.screen.dispose();
      try {
        term.proc.kill();
      } catch {
        // already gone
      }
      this.active.delete(id);
    }
  }

  // -------------------------------------------------------------------------

  private armIdleTimer(id: string, broadcast: TerminalBroadcasts): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const term = this.active.get(id);
      if (!term) return;
      this.log.info({ terminal: id }, 'terminal idle timeout — killing');
      this.kill(id, broadcast);
    }, IDLE_MS);
    timer.unref?.();
    return timer;
  }

  private touchIdle(term: ActiveTerminal, id: string, broadcast: TerminalBroadcasts): void {
    clearTimeout(term.idleTimer);
    term.idleTimer = this.armIdleTimer(id, broadcast);
  }
}
