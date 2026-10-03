/**
 * TerminalManager: real PTY shells ("Code" tab), project-scoped.
 *
 * - spawns $SHELL (fallback /bin/bash) in the project path via node-pty
 * - optionally runs inside a detached tmux session under a private socket,
 *   making terminal sessions persistent across server restarts / crashes / rebuilds
 * - optionally types a launch command (agent TUI preset) into the fresh shell
 * - streams UTF-8 chunks to every authed client (single-user deck)
 * - detects "needs attention" (bell, OSC 9/777 notifications, quiet after work)
 * - caps concurrency, reaps idle terminals, detaches on shutdown, restores on reboot
 */
import fs from 'node:fs';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { pty } from './pty.js';
import type { TerminalInfo } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { newTerminalId } from '../util/ids.js';
import { augmentedPath } from './presets.js';
import { AttentionDetector, type AttentionReason } from './attention.js';
import { classifyScreen, type Verdict } from '../notify/classify.js';
import {
  isTmuxAvailable,
  tmuxSocketPath,
  tmuxSessionName,
  createTmuxSession,
  applyTmuxSessionOptions,
  hasTmuxSession,
  killTmuxSession,
  resizeTmuxWindow,
  captureTmuxPane,
} from './tmux.js';

export interface TerminalBroadcasts {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  onList: () => void;
  /** Terminal wants the user (bell / notification / finished work). */
  onAttention?: (info: TerminalInfo, reason: AttentionReason, verdict: Verdict) => void;
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

export interface TerminalManagerOptions {
  dataDir?: string;
  /** Use tmux for session persistence across server restarts (defaults to isTmuxAvailable()). */
  useTmux?: boolean;
  serverPid?: number;
  serverPort?: number;
}

export interface PersistedTerminal {
  info: TerminalInfo;
  projectPath: string;
  tmuxSession?: string;
}

interface ActiveTerminal {
  info: TerminalInfo;
  proc: import('node-pty').IPty;
  idleTimer: NodeJS.Timeout;
  lastTouched?: number;
  /**
   * Server-side terminal emulator mirroring the PTY. It answers terminal
   * queries (cursor position, colors) even when no phone is attached and
   * serializes a clean screen snapshot for (re)connecting clients.
   */
  screen: InstanceType<typeof xtermHeadless.Terminal>;
  serializer: InstanceType<typeof serializeAddon.SerializeAddon>;
  attention: AttentionDetector;
  tmuxSession?: string;
  projectPath: string;
  detaching?: boolean;
}

const MAX_CONCURRENT = 10;
/** Agent TUIs sit silently for hours while you are away — reap only truly dead shells. */
const IDLE_MS = 12 * 60 * 60_000;
const SCROLLBACK = 5000;
const REPLAY_SCROLLBACK = 5000;

/** The visible screen as plain text, one line per row. */
function screenText(screen: ActiveTerminal['screen']): string {
  const buffer = screen.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < screen.rows; y++) {
    rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
  }
  return rows.join('\n');
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

  constructor(
    private readonly log: Logger,
    private readonly options: TerminalManagerOptions = {},
  ) {}

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
      const snap = t.serializer.serialize({ scrollback: REPLAY_SCROLLBACK });
      if (snap && snap.trim()) return snap;
      if (t.tmuxSession) {
        return captureTmuxPane(t.tmuxSession, REPLAY_SCROLLBACK);
      }
      return '';
    } catch {
      if (t.tmuxSession) {
        return captureTmuxPane(t.tmuxSession, REPLAY_SCROLLBACK);
      }
      return '';
    }
  }

  /** Server env minus npm-run noise, plus AgentDeck server markers for scripts/agents. */
  private shellEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE_ENV') continue;
      env[k] = v;
    }
    env.LANG = 'en_GB.UTF-8';
    env.LC_TIME = 'en_GB.UTF-8';
    env.LC_ALL = 'en_GB.UTF-8';
    env.AGENTDECK_SERVER_PID = String(this.options.serverPid ?? process.pid);
    env.AGENTDECK_INSIDE_TERMINAL = '1';
    if (this.options.serverPort) env.AGENTDECK_PORT = String(this.options.serverPort);
    if (this.options.dataDir) env.AGENTDECK_DATA_DIR = this.options.dataDir;
    return env;
  }

  // --- Persistence -----------------------------------------------------------

  private persistedFilePath(): string | undefined {
    return this.options.dataDir ? path.join(this.options.dataDir, 'terminals.json') : undefined;
  }

  private loadPersisted(): PersistedTerminal[] {
    const fp = this.persistedFilePath();
    if (!fp || !fs.existsSync(fp)) return [];
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.log.warn({ err, fp }, 'failed to read persisted terminals');
      return [];
    }
  }

  private savePersisted(): void {
    const fp = this.persistedFilePath();
    if (!fp) return;
    try {
      const records: PersistedTerminal[] = [...this.active.values()].map((t) => ({
        info: t.info,
        projectPath: t.projectPath,
        ...(t.tmuxSession ? { tmuxSession: t.tmuxSession } : {}),
      }));
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.log.warn({ err, fp }, 'failed to write persisted terminals');
    }
  }

  private removePersisted(id: string): void {
    const fp = this.persistedFilePath();
    if (!fp || !fs.existsSync(fp)) return;
    try {
      const list = this.loadPersisted().filter((t) => t.info.id !== id);
      const tmp = `${fp}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.log.warn({ err, id }, 'failed to update persisted terminals');
    }
  }

  private clearPersisted(): void {
    const fp = this.persistedFilePath();
    if (!fp || !fs.existsSync(fp)) return;
    try {
      fs.unlinkSync(fp);
    } catch {
      // ignore
    }
  }

  // --- Spawning & Restoration ------------------------------------------------

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
    const useTmux = this.options.useTmux ?? isTmuxAvailable();

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
    let tmuxSession: string | undefined = undefined;

    if (useTmux) {
      const sName = tmuxSessionName(id);
      const env = {
        ...this.shellEnv(),
        PATH: augmentedPath(process.env.PATH),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENTDECK_PROJECT: path.basename(projectPath),
        AGENTDECK_PERSISTENT_TERM: '1',
      };
      const ok = createTmuxSession({
        sessionName: sName,
        cwd: projectPath,
        cols,
        rows,
        shell,
        args,
        env,
      });
      if (ok) {
        tmuxSession = sName;
        info.persistent = true;
      } else {
        this.log.warn({ terminal: id }, 'tmux session creation failed — falling back to direct PTY');
      }
    }

    const proc: import('node-pty').IPty = tmuxSession
      ? pty.spawn('tmux', ['-S', tmuxSocketPath(), 'attach-session', '-t', tmuxSession], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: projectPath,
          env: {
            ...this.shellEnv(),
            PATH: augmentedPath(process.env.PATH),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          } as Record<string, string>,
        })
      : pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: projectPath,
          env: {
            ...this.shellEnv(),
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
      tmuxSession,
      projectPath,
      idleTimer: this.armIdleTimer(id, broadcast),
      attention: new AttentionDetector({
        // "Quiet after work" only makes sense for agent TUIs; a plain shell
        // going quiet after `ls` is not news.
        idleNotify: opts.idleNotify === true,
        onAttention: (reason, text) => this.raiseAttention(id, term, broadcast, reason, text),
      }),
    };
    this.active.set(id, term);
    this.savePersisted();

    proc.onData((data) => {
      broadcast.onData(id, data);
      term.info.lastOutputAt = Date.now();
      term.screen.write(data);
      term.attention.output(data);
      this.touchIdle(term, id, broadcast);
    });

    proc.onExit(({ exitCode }) => {
      if (term.detaching) return;
      clearTimeout(term.idleTimer);
      term.attention.dispose();
      term.screen.dispose();
      // An explicit kill() already removed+broadcast this terminal — only
      // natural exits (user typed `exit`) run the cleanup path.
      if (this.active.get(id) !== term) return;
      this.active.delete(id);
      this.removePersisted(id);
      this.log.info({ terminal: id, code: exitCode }, 'terminal exited');
      broadcast.onExit(id, exitCode);
      broadcast.onList();
    });

    this.log.info({ terminal: id, projectId, shell, persistent: !!tmuxSession }, 'terminal spawned');
    broadcast.onList();
    return info;
  }

  /**
   * Re-attaches to live tmux terminal sessions after server restart or crash.
   * Restores xterm-headless state and announces active terminals to the client.
   */
  restoreAll(broadcast: TerminalBroadcasts): void {
    const useTmux = this.options.useTmux ?? isTmuxAvailable();
    if (!useTmux) return;
    const records = this.loadPersisted();
    let changed = false;
    for (const rec of records) {
      if (this.active.has(rec.info.id)) continue;
      if (!rec.tmuxSession || !hasTmuxSession(rec.tmuxSession)) {
        // Session ended while server was down
        changed = true;
        continue;
      }
      try {
        this.restoreOne(rec, broadcast);
        changed = true;
      } catch (err) {
        this.log.error({ err, id: rec.info.id }, 'failed to restore tmux terminal session');
        changed = true;
      }
    }
    if (changed) {
      this.savePersisted();
      broadcast.onList();
    }
  }

  private restoreOne(rec: PersistedTerminal, broadcast: TerminalBroadcasts): void {
    const { info, projectPath, tmuxSession } = rec;
    if (!tmuxSession) return;
    const id = info.id;

    info.persistent = true;

    // Session may predate options added since it was created (e.g. mouse on).
    applyTmuxSessionOptions(tmuxSession);

    const proc = pty.spawn('tmux', ['-S', tmuxSocketPath(), 'attach-session', '-t', tmuxSession], {
      name: 'xterm-256color',
      cols: info.cols,
      rows: info.rows,
      cwd: projectPath,
      env: {
        ...this.shellEnv(),
        PATH: augmentedPath(process.env.PATH),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENTDECK_PROJECT: path.basename(projectPath),
      } as Record<string, string>,
    });

    const screen = new xtermHeadless.Terminal({ cols: info.cols, rows: info.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new serializeAddon.SerializeAddon();
    screen.loadAddon(serializer);

    // Pre-populate screen with scrollback from the still-running tmux pane
    const captured = captureTmuxPane(tmuxSession, REPLAY_SCROLLBACK);
    if (captured) {
      screen.write(captured);
    }

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
      tmuxSession,
      projectPath,
      idleTimer: this.armIdleTimer(id, broadcast),
      attention: new AttentionDetector({
        idleNotify: info.presetId !== 'shell',
        onAttention: (reason, text) => this.raiseAttention(id, term, broadcast, reason, text),
      }),
    };

    this.active.set(id, term);

    proc.onData((data) => {
      broadcast.onData(id, data);
      term.info.lastOutputAt = Date.now();
      term.screen.write(data);
      term.attention.output(data);
      this.touchIdle(term, id, broadcast);
    });

    proc.onExit(({ exitCode }) => {
      if (term.detaching) return;
      clearTimeout(term.idleTimer);
      term.attention.dispose();
      term.screen.dispose();
      if (this.active.get(id) !== term) return;
      this.active.delete(id);
      this.removePersisted(id);
      this.log.info({ terminal: id, code: exitCode }, 'restored terminal exited');
      broadcast.onExit(id, exitCode);
      broadcast.onList();
    });

    this.log.info({ terminal: id, tmuxSession }, 'terminal restored from tmux session');
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
      if (term.tmuxSession) {
        resizeTmuxWindow(term.tmuxSession, c, r);
      }
      this.savePersisted();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Flags the terminal and reports why. The verdict is read off the screen
   * once the emulator has parsed everything written so far — the bell usually
   * arrives in the same chunk as the prompt it rings for.
   */
  private raiseAttention(
    id: string,
    term: ActiveTerminal,
    broadcast: TerminalBroadcasts,
    reason: AttentionReason,
    text?: string,
  ): void {
    term.screen.write('', () => {
      if (this.active.get(id) !== term) return;
      const verdict = classifyScreen(screenText(term.screen), text);
      const changed = !term.info.attention || term.info.attentionState !== verdict.state;
      term.info.attention = true;
      term.info.attentionState = verdict.state;
      broadcast.onAttention?.(term.info, reason, verdict);
      if (changed) broadcast.onList();
    });
  }

  /** What the terminal's screen asks right now (a fresh read, not the last alert). */
  async currentVerdict(id: string): Promise<Verdict | undefined> {
    const term = this.active.get(id);
    if (!term) return undefined;
    await new Promise<void>((resolve) => term.screen.write('', resolve));
    return classifyScreen(screenText(term.screen));
  }

  /** The user looked at the terminal — clear its attention flag. */
  markSeen(id: string, broadcast: TerminalBroadcasts): void {
    const term = this.active.get(id);
    if (!term || !term.info.attention) return;
    term.info.attention = false;
    delete term.info.attentionState;
    broadcast.onList();
  }

  kill(id: string, broadcast: TerminalBroadcasts): boolean {
    const term = this.active.get(id);
    if (!term) {
      // Check if it exists in persisted records or tmux
      const records = this.loadPersisted();
      const rec = records.find((r) => r.info.id === id);
      if (rec?.tmuxSession) {
        killTmuxSession(rec.tmuxSession);
        this.removePersisted(id);
        broadcast.onExit(id, -1);
        broadcast.onList();
        return true;
      }
      return false;
    }
    term.attention.dispose();
    term.screen.dispose();
    clearTimeout(term.idleTimer);
    this.active.delete(id);
    this.removePersisted(id);
    if (term.tmuxSession) {
      killTmuxSession(term.tmuxSession);
    }
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

  /** Hard-kills all terminals and their tmux sessions (tests, full teardown). */
  killAll(): void {
    for (const id of [...this.active.keys()]) {
      const term = this.active.get(id);
      if (!term) continue;
      clearTimeout(term.idleTimer);
      term.attention.dispose();
      term.screen.dispose();
      if (term.tmuxSession) {
        killTmuxSession(term.tmuxSession);
      }
      try {
        term.proc.kill();
      } catch {
        // already gone
      }
      this.active.delete(id);
    }
    this.clearPersisted();
  }

  /**
   * Graceful server shutdown / restart:
   * Detaches node-pty from tmux sessions and saves state to disk, but
   * LEAVES tmux sessions alive so running agents / jobs continue running.
   */
  detachAll(): void {
    for (const id of [...this.active.keys()]) {
      const term = this.active.get(id);
      if (!term) continue;
      term.detaching = true;
      clearTimeout(term.idleTimer);
      term.attention.dispose();
      term.screen.dispose();
      try {
        term.proc.kill(); // detaches node-pty from tmux attach, leaves tmux session alive!
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
    const now = Date.now();
    if (now - (term.lastTouched ?? 0) < 60_000) return;
    term.lastTouched = now;
    clearTimeout(term.idleTimer);
    term.idleTimer = this.armIdleTimer(id, broadcast);
  }
}
