/**
 * TerminalManager: real PTY shells ("Code" tab), project-scoped.
 *
 * - spawns $SHELL (fallback /bin/bash) in the project path via node-pty
 * - streams UTF-8 chunks to every authed client (single-user deck)
 * - caps concurrency, reaps idle terminals, kills everything on shutdown
 */
import path from 'node:path';
import { pty } from './pty.js';
import type { TerminalInfo } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { newTerminalId } from '../util/ids.js';

export interface TerminalBroadcasts {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  onList: () => void;
}

interface ActiveTerminal {
  info: TerminalInfo;
  proc: import('node-pty').IPty;
  idleTimer: NodeJS.Timeout;
  /** Ring buffer of recent output so a freshly (re)connected client can repaint. */
  replay: string;
}

const MAX_CONCURRENT = 6;
const IDLE_MS = 15 * 60_000;
const REPLAY_LIMIT = 24_000; // chars (~a screenful of scrollback)

export class TerminalManager {
  private readonly active = new Map<string, ActiveTerminal>();

  constructor(private readonly log: Logger) {}

  list(projectId?: string): TerminalInfo[] {
    const all = [...this.active.values()].map((t) => t.info);
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }

  get(id: string): { info: TerminalInfo; replay: string } | undefined {
    const t = this.active.get(id);
    return t ? { info: t.info, replay: t.replay } : undefined;
  }

  /** Output buffered so far — used when a client (re)attaches to a terminal. */
  replayOf(id: string): string | undefined {
    return this.active.get(id)?.replay;
  }

  spawn(projectPath: string, projectId: string, cols: number, rows: number, broadcast: TerminalBroadcasts): TerminalInfo {
    if (this.active.size >= MAX_CONCURRENT) {
      // Reap the oldest terminal instead of refusing — phone users churn tabs.
      const oldest = [...this.active.values()].sort((a, b) => a.info.createdAt - b.info.createdAt)[0];
      if (oldest) this.kill(oldest.info.id, broadcast);
    }
    const id = newTerminalId();
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/bash';
    const info: TerminalInfo = { id, projectId, createdAt: Date.now(), cols, rows };
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: projectPath,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENTDECK_PROJECT: path.basename(projectPath),
      } as Record<string, string>,
    });
    const term: ActiveTerminal = {
      info,
      proc,
      replay: '',
      idleTimer: this.armIdleTimer(id, broadcast),
    };
    this.active.set(id, term);
    proc.onData((data) => {
      term.replay = (term.replay + data).slice(-REPLAY_LIMIT);
      this.touchIdle(term, id, broadcast);
      broadcast.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(term.idleTimer);
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
      term.info.cols = c;
      term.info.rows = r;
      return true;
    } catch {
      return false;
    }
  }

  kill(id: string, broadcast: TerminalBroadcasts): boolean {
    const term = this.active.get(id);
    if (!term) return false;
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
