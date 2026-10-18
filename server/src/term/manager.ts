/**
 * TerminalManager: real PTY shells ("Code" tab), project-scoped.
 *
 * - spawns $SHELL (fallback /bin/bash) in the project path via node-pty
 * - optionally runs inside a detached tmux session under a private socket,
 *   making terminal sessions persistent across server restarts / crashes / rebuilds
 * - optionally types a launch command (agent TUI preset) into the fresh shell
 * - streams UTF-8 chunks to every authed client (single-user deck)
 * - detects "needs attention" (bell, OSC 9/777 notifications, quiet after work;
 *   Claude Code reports it itself through hooks — see claudeHooks.ts)
 * - caps concurrency, reaps idle terminals, detaches on shutdown, restores on reboot
 */
import fs from 'node:fs';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import unicode11Addon from '@xterm/addon-unicode11';
import { pty } from './pty.js';
import type { TerminalInfo } from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { newTerminalId } from '../util/ids.js';
import { augmentedPath, PRESET_DEFS } from './presets.js';
import { trackMouseEncoding, type MouseEncoding } from './mouseEncoding.js';
import { answerPixelQueries, DEFAULT_CELL, PIXEL_QUERIES, type CellSize } from './pixelSize.js';
import { AttentionDetector, isTyped, type AttentionReason } from './attention.js';
import { classifyScreen, type PromptKind, type Verdict } from '../notify/classify.js';
import type { DeckNotificationState } from '@agentdeck/shared';
import { interpretClaudeHook, removeClaudeHookSettings, withClaudeHooks, writeClaudeHookSettings } from './claudeHooks.js';
import {
  isTmuxAvailable,
  lastTmuxFailure,
  rejectedTmuxBinaries,
  tmuxSessionState,
  tmuxCommand,
  tmuxSocketPath,
  tmuxSessionName,
  tmuxPanePid,
  createTmuxSession,
  applyTmuxSessionOptions,
  killTmuxSession,
  resizeTmuxWindow,
  captureTmuxPane,
} from './tmux.js';

export interface TerminalBroadcasts {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  onList: () => void;
  /** Terminal wants the user (bell / notification / finished work). */
  onAttention?: (info: TerminalInfo, reason: AttentionReason, verdict: AttentionVerdict) => void;
}

/** A screen verdict, or what the program reported itself (which can also be a failure). */
export interface AttentionVerdict {
  state: DeckNotificationState;
  prompt?: PromptKind;
  detail?: string;
}

export interface SpawnOptions {
  title?: string;
  presetId?: string;
  variantId?: string;
  /** Run inside the login shell right after spawn (agent TUI, dev server …). */
  command?: string;
  /** Report "quiet after work" (agent TUIs); bell/OSC notifications always count. */
  idleNotify?: boolean;
  /** Zone for clock times shown in the terminal (the device's); default is the server's. */
  timeZone?: string;
  /** Extra environment (an account profile: CLAUDE_CONFIG_DIR, CODEX_HOME …). */
  env?: Record<string, string>;
}

export interface TerminalManagerOptions {
  dataDir?: string;
  /** Use tmux for session persistence across server restarts (defaults to isTmuxAvailable()). */
  useTmux?: boolean;
  serverPid?: number;
  serverPort?: number;
  /** Bridge token Claude Code terminals present when their hooks report in. */
  hookToken?: string;
  /** An agent in a terminal finished a turn (activity database). */
  onTurn?: (turn: TerminalTurn) => void;
}

/** One finished turn of an agent TUI: from the user's prompt to the agent going idle. */
export interface TerminalTurn {
  info: TerminalInfo;
  startedAt: number;
  endedAt: number;
  state: DeckNotificationState;
  /** Claude Code: what the user asked, and the transcript that holds the turn's usage. */
  prompt?: string;
  transcriptPath?: string;
  /** How it ended, in the agent's words. */
  detail?: string;
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
  /** Mouse encoding the serializer leaves out of snapshots (see mouseEncoding.ts). */
  mouseEncoding: MouseEncoding;
  /** Cell size in pixels as the app measured it (images, see pixelSize.ts). */
  cell: CellSize;
  attention: AttentionDetector;
  tmuxSession?: string;
  projectPath: string;
  detaching?: boolean;
  /** A dialog was announced by a hook; reported once the screen shows it. */
  askTimer?: NodeJS.Timeout;
  /** When a dialog was last reported — its follow-up notification is the same news. */
  askedAt?: number;
  /** Agent TUI: its turns go on record. */
  agent: boolean;
  /** Claude Code reports through hooks — its turns start and end there, not at a keypress. */
  hooked?: boolean;
  /** The turn the agent is working on. */
  turn?: { startedAt: number; prompt?: string; transcriptPath?: string };
  /** The last prompt a hook reported — what a hand-over continues. */
  lastPrompt?: string;
}

const MAX_CONCURRENT = 10;
/** Agent TUIs sit silently for hours while you are away — reap only truly dead shells. */
const IDLE_MS = 12 * 60 * 60_000;
const SCROLLBACK = 5000;
const REPLAY_SCROLLBACK = 5000;
/** Time for a dialog to appear on screen — and for a user sitting at it to answer first. */
const ASK_GRACE_MS = 1500;
/** Claude follows a dialog with its own notification a few seconds later. */
const ASK_REPEAT_MS = 20_000;

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

/**
 * Unicode 11 character widths, as the app's xterm uses: emoji and symbols in
 * agent TUIs are two cells wide there, and the snapshot must agree.
 */
function applyUnicode11(screen: InstanceType<typeof xtermHeadless.Terminal>): void {
  screen.loadAddon(new unicode11Addon.Unicode11Addon());
  screen.unicode.activeVersion = '11';
}

export class TerminalManager {
  private readonly active = new Map<string, ActiveTerminal>();

  constructor(
    private readonly log: Logger,
    private readonly options: TerminalManagerOptions = {},
  ) {}

  /** What another agent needs to take over: folder, preset, last prompt and the screen's tail. */
  handoverContext(id: string): { cwd: string; projectId: string; presetId?: string; title?: string; prompt?: string; screen: string } | undefined {
    const t = this.active.get(id);
    if (!t) return undefined;
    const screen = screenText(t.screen)
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, i, all) => l || (i > 0 && all[i - 1]))
      .slice(-40)
      .join('\n')
      .trim();
    return {
      cwd: t.projectPath,
      projectId: t.info.projectId,
      ...(t.info.presetId ? { presetId: t.info.presetId } : {}),
      ...(t.info.title ? { title: t.info.title } : {}),
      ...(t.lastPrompt ? { prompt: t.lastPrompt } : {}),
      screen,
    };
  }

  /** Root process of each terminal: the tmux pane's shell, or the PTY's. */
  rootPids(): { id: string; pid: number }[] {
    const out: { id: string; pid: number }[] = [];
    for (const [id, t] of this.active) {
      const pid = t.tmuxSession ? tmuxPanePid(t.tmuxSession) : t.proc.pid;
      if (pid) out.push({ id, pid });
    }
    return out;
  }

  /** Agent terminals at work: in a turn, or printing within the last minute. */
  busyAgents(now = Date.now()): number {
    let n = 0;
    for (const t of this.active.values()) {
      if (!t.agent) continue;
      if (t.turn || (t.info.lastOutputAt !== undefined && now - t.info.lastOutputAt < 60_000)) n++;
    }
    return n;
  }

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
      if (snap && snap.trim()) return snap + t.mouseEncoding.modes();
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

  /** The launch command as the shell runs it: Claude Code gets its hook settings attached. */
  private launchCommand(id: string, opts: SpawnOptions): string {
    const command = opts.command ?? '';
    const { dataDir, serverPort, hookToken } = this.options;
    if (opts.presetId !== 'claude' || !dataDir || !serverPort || !hookToken) return command;
    try {
      return withClaudeHooks(command, writeClaudeHookSettings(dataDir, id, serverPort, hookToken));
    } catch (err) {
      this.log.warn({ err, terminal: id }, 'could not write Claude hook settings — falling back to screen heuristics');
      return command;
    }
  }

  private removeHooks(id: string): void {
    if (!this.options.dataDir) return;
    try {
      removeClaudeHookSettings(this.options.dataDir, id);
    } catch {
      // stale file is harmless
    }
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

  /**
   * Records of terminals whose tmux session could not be checked or attached at
   * startup (tmux of another version than the running tmux server, a crash …):
   * not shown, but kept in terminals.json — the sessions may well be alive.
   */
  private readonly unrestored = new Map<string, PersistedTerminal>();

  private savePersisted(): void {
    const fp = this.persistedFilePath();
    if (!fp) return;
    try {
      const records: PersistedTerminal[] = [...this.active.values()].map((t) => ({
        info: t.info,
        projectPath: t.projectPath,
        ...(t.tmuxSession ? { tmuxSession: t.tmuxSession } : {}),
      }));
      for (const rec of this.unrestored.values()) {
        if (!this.active.has(rec.info.id)) records.push(rec);
      }
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
    this.unrestored.clear();
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
    const args = opts.command ? shellArgsFor(shell, this.launchCommand(id, opts)) : ['-l'];
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
        ...(opts.timeZone ? { TZ: opts.timeZone } : {}),
        ...(opts.env ?? {}),
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
        this.log.warn({ terminal: id, reason: lastTmuxFailure() }, 'tmux session creation failed — falling back to direct PTY (this terminal will not survive a server restart)');
      }
    }

    const proc: import('node-pty').IPty = tmuxSession
      ? pty.spawn(tmuxCommand(), ['-S', tmuxSocketPath(), 'attach-session', '-t', tmuxSession], {
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
            ...(opts.timeZone ? { TZ: opts.timeZone } : {}),
            ...(opts.env ?? {}),
          } as Record<string, string>,
        });

    const screen = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true, windowOptions: PIXEL_QUERIES });
    const serializer = new serializeAddon.SerializeAddon();
    screen.loadAddon(serializer);
    applyUnicode11(screen);
    const mouseEncoding = trackMouseEncoding(screen);

    // Query responses (DSR, DA, OSC 10/11) go straight back into the PTY.
    screen.onData((reply) => {
      try {
        proc.write(reply);
      } catch {
        // pty gone
      }
    });
    // tmux asks the pixel size to place images (see pixelSize.ts).
    const cell: CellSize = { ...DEFAULT_CELL };
    answerPixelQueries(
      screen,
      (reply) => {
        try {
          proc.write(reply);
        } catch {
          // pty gone
        }
      },
      () => cell,
    );

    const term: ActiveTerminal = {
      info,
      proc,
      screen,
      serializer,
      mouseEncoding,
      cell,
      tmuxSession,
      projectPath,
      idleTimer: this.armIdleTimer(id, broadcast),
      agent: opts.idleNotify === true,
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
      clearTimeout(term.askTimer);
      this.active.delete(id);
      this.removePersisted(id);
      this.removeHooks(id);
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
    for (const bad of rejectedTmuxBinaries()) {
      this.log.error({ tmux: bad.path, reason: bad.reason }, 'tmux binary found but it does not run — skipped');
    }
    if (!useTmux) return;
    const records = this.loadPersisted();
    let changed = false;
    for (const rec of records) {
      if (this.active.has(rec.info.id)) continue;
      if (!rec.tmuxSession) {
        changed = true; // a plain PTY did not outlive the server
        continue;
      }
      const state = tmuxSessionState(rec.tmuxSession);
      if (state === 'absent') {
        // tmux itself says the session is gone: it ended while the server was down
        changed = true;
        continue;
      }
      if (state === 'unknown') {
        // Not the same as gone: keep the record (and the tmux session with the agent inside) for the next start.
        this.unrestored.set(rec.info.id, rec);
        changed = true;
        this.log.error(
          { terminal: rec.info.id, tmuxSession: rec.tmuxSession, reason: lastTmuxFailure() },
          'cannot ask tmux about a saved terminal — keeping it; tmux and its sessions may be of another version than this server uses (AGENTDECK_TMUX)',
        );
        continue;
      }
      try {
        this.restoreOne(rec, broadcast);
        changed = true;
      } catch (err) {
        this.unrestored.set(rec.info.id, rec);
        this.log.error({ err, id: rec.info.id }, 'failed to restore tmux terminal session — keeping it for the next start');
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

    const proc = pty.spawn(tmuxCommand(), ['-S', tmuxSocketPath(), 'attach-session', '-t', tmuxSession], {
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

    const screen = new xtermHeadless.Terminal({ cols: info.cols, rows: info.rows, scrollback: SCROLLBACK, allowProposedApi: true, windowOptions: PIXEL_QUERIES });
    const serializer = new serializeAddon.SerializeAddon();
    screen.loadAddon(serializer);
    applyUnicode11(screen);
    const mouseEncoding = trackMouseEncoding(screen);

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
    // tmux asks the pixel size to place images (see pixelSize.ts).
    const cell: CellSize = { ...DEFAULT_CELL };
    answerPixelQueries(
      screen,
      (reply) => {
        try {
          proc.write(reply);
        } catch {
          // pty gone
        }
      },
      () => cell,
    );

    const term: ActiveTerminal = {
      info,
      proc,
      screen,
      serializer,
      mouseEncoding,
      cell,
      tmuxSession,
      projectPath,
      idleTimer: this.armIdleTimer(id, broadcast),
      agent: PRESET_DEFS.some((p) => p.id === info.presetId && p.kind === 'agent'),
      attention: new AttentionDetector({
        idleNotify: info.presetId !== 'shell',
        // It may have been given work before the restart.
        prompted: true,
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
      clearTimeout(term.askTimer);
      this.active.delete(id);
      this.removePersisted(id);
      this.removeHooks(id);
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
      term.attention.input(isTyped(data));
      // Enter hands the agent its next piece of work.
      if (term.agent && !term.hooked && !term.turn && data.includes('\r') && isTyped(data)) {
        term.turn = { startedAt: Date.now() };
      }
      // Answered before it was reported — nothing left to announce.
      clearTimeout(term.askTimer);
      return true;
    } catch {
      return false;
    }
  }

  /** `broadcast` tells every device the new size — the ones not sizing it draw at it too. */
  resize(id: string, cols: number, rows: number, cell?: CellSize, broadcast?: TerminalBroadcasts): boolean {
    const term = this.active.get(id);
    if (!term) return false;
    if (cell && cell.width >= 2 && cell.width <= 100 && cell.height >= 4 && cell.height <= 200) {
      term.cell.width = Math.round(cell.width);
      term.cell.height = Math.round(cell.height);
    }
    const c = Math.min(Math.max(10, Math.round(cols)), 500);
    const r = Math.min(Math.max(4, Math.round(rows)), 300);
    // Devices re-send their size on every touch (see the web app's termClaim.ts).
    if (c === term.info.cols && r === term.info.rows) return true;
    try {
      term.proc.resize(c, r);
      term.screen.resize(c, r);
      // The redraw that follows is not work.
      term.attention.input();
      term.info.cols = c;
      term.info.rows = r;
      if (term.tmuxSession) {
        resizeTmuxWindow(term.tmuxSession, c, r);
      }
      this.savePersisted();
      broadcast?.onList();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Flags the terminal and reports why. The verdict is read off the screen
   * once the emulator has parsed everything written so far — the bell usually
   * arrives in the same chunk as the prompt it rings for. `reported` is what
   * the program said itself; the screen then only adds how to answer.
   */
  private raiseAttention(
    id: string,
    term: ActiveTerminal,
    broadcast: TerminalBroadcasts,
    reason: AttentionReason,
    text?: string,
    reported?: { state: DeckNotificationState; detail?: string; ifOnScreen?: boolean },
  ): void {
    term.screen.write('', () => {
      if (this.active.get(id) !== term) return;
      const seen = classifyScreen(screenText(term.screen), text);
      let verdict: AttentionVerdict = seen;
      if (reported) {
        if (reported.ifOnScreen && seen.state !== 'waiting') return;
        const detail = reported.detail ?? (seen.state === reported.state ? seen.detail : undefined);
        verdict = {
          state: reported.state,
          ...(reported.state === 'waiting' && seen.prompt ? { prompt: seen.prompt } : {}),
          ...(detail ? { detail } : {}),
        };
        if (reported.state === 'waiting') term.askedAt = Date.now();
      }
      const changed = !term.info.attention || term.info.attentionState !== verdict.state;
      term.info.attention = true;
      term.info.attentionState = verdict.state;
      if (verdict.state !== 'waiting' && term.turn) {
        const turn = term.turn;
        delete term.turn;
        this.options.onTurn?.({
          info: { ...term.info },
          startedAt: turn.startedAt,
          // "Quiet after work" is noticed late: the work ended with the last output.
          endedAt: reason === 'idle' ? Math.max(term.info.lastOutputAt ?? Date.now(), turn.startedAt) : Date.now(),
          state: verdict.state,
          ...(turn.prompt ? { prompt: turn.prompt } : {}),
          ...(turn.transcriptPath ? { transcriptPath: turn.transcriptPath } : {}),
          ...(verdict.detail ? { detail: verdict.detail } : {}),
        });
      }
      this.log.info({ terminal: id, reason, state: verdict.state }, 'terminal attention');
      // One notification per attention state: when a rate limit keeps ending
      // turns, Claude sends several Stop/StopFailure hooks for the same limit
      // and each one used to buzz again. A waiting terminal still re-asks on
      // purpose (ASK_REPEAT_MS in hookEvent).
      if (changed || verdict.state === 'waiting') broadcast.onAttention?.(term.info, reason, verdict);
      if (changed) broadcast.onList();
    });
  }

  /**
   * A Claude Code hook reported in (see claudeHooks.ts). Returns false when
   * the terminal is gone.
   */
  hookEvent(id: string, payload: unknown, broadcast: TerminalBroadcasts): boolean {
    const term = this.active.get(id);
    if (!term) return false;
    // Hooks work here, and they are exact: the quiet-after-work guess would
    // only add late and vaguer duplicates.
    term.attention.stopIdleNotify();
    term.hooked = true;
    const signal = interpretClaudeHook(payload);
    if (!signal) return true;
    clearTimeout(term.askTimer);
    const text = (key: string): string | undefined => {
      const value = (payload as Record<string, unknown>)[key];
      return typeof value === 'string' && value ? value : undefined;
    };
    if (signal.kind === 'working') {
      delete term.askedAt;
      const prompt = text('prompt');
      term.turn = { startedAt: Date.now(), ...(prompt ? { prompt } : {}) };
      if (prompt) term.lastPrompt = prompt;
    } else if (signal.kind === 'result') {
      delete term.askedAt;
      const transcriptPath = text('transcript_path');
      if (term.turn && transcriptPath) term.turn.transcriptPath = transcriptPath;
      this.raiseAttention(id, term, broadcast, 'notify', undefined, signal);
    } else if (signal.confirmed) {
      if (term.askedAt === undefined || Date.now() - term.askedAt > ASK_REPEAT_MS) {
        this.raiseAttention(id, term, broadcast, 'notify', undefined, { state: 'waiting', detail: signal.detail });
      }
    } else {
      // Sent before the dialog is drawn, and also for requests that get
      // settled without one — only what reaches the screen is reported.
      term.askTimer = setTimeout(() => {
        this.raiseAttention(id, term, broadcast, 'notify', undefined, {
          state: 'waiting',
          detail: signal.detail,
          ifOnScreen: true,
        });
      }, ASK_GRACE_MS);
      term.askTimer.unref?.();
    }
    return true;
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
        this.unrestored.delete(id);
        this.removePersisted(id);
        this.removeHooks(id);
        broadcast.onExit(id, -1);
        broadcast.onList();
        return true;
      }
      return false;
    }
    term.attention.dispose();
    term.screen.dispose();
    clearTimeout(term.idleTimer);
    clearTimeout(term.askTimer);
    this.active.delete(id);
    this.removePersisted(id);
    this.removeHooks(id);
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
      clearTimeout(term.askTimer);
      term.attention.dispose();
      term.screen.dispose();
      this.removeHooks(id);
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
      clearTimeout(term.askTimer);
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
