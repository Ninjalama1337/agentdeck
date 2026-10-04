/**
 * AgentManager: owns the lifecycle of agent runs.
 *
 * - guards (single active run per session, headless capability)
 * - spawns adapter-built plans via execa (cwd = project path)
 * - splits stdout into lines → adapter parser → normalized AgentEvents
 * - broadcasts live events, accumulates text deltas into one assistant
 *   ChatMessage flushed at the end (tool events are ephemeral)
 * - kills runs on interrupt / maxRunMs (SIGINT → 3s → SIGKILL, process group)
 */
import fsp from 'node:fs/promises';
import { execa } from 'execa';
import { ThinkTagSplitter } from '@agentdeck/shared';
import type {
  AgentEvent,
  ChatMessage,
  MessageUsage,
  Project,
  Session,
  SessionStatus,
  ThinkPart,
  ToolRecord,
} from '@agentdeck/shared';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentService } from './registry.js';
import { newMessageId } from '../util/ids.js';
import { ensureDir } from '../util/paths.js';
import { truncate } from './types.js';
import type { AgentAdapter, RunAttachment, RunPlan } from './types.js';

type Child = ReturnType<typeof execa>;

export interface TurnOutcome {
  ok: boolean;
  text: string;
  error?: string;
}

export type SessionEventEmitter = (sessionId: string, event: AgentEvent) => void;

export interface StartTurnOptions {
  session: Session;
  project: Project;
  text: string;
  attachments: RunAttachment[];
  model?: string;
  /** Per-turn effort override; falls back to session.thinkingEffort. */
  thinkingEffort?: string;
  source: NonNullable<ChatMessage['source']>;
  /** Per-run override of config.maxRunMs. */
  maxRunMs?: number;
}

export type StartGate = { ok: true } | { ok: false; code: string; message: string };

interface ActiveRun {
  sessionId: string;
  session: Session;
  adapter: AgentAdapter;
  plan: RunPlan;
  child: Child;
  timer: NodeJS.Timeout;
  exited: boolean;
  interrupted: boolean;
  externalId?: string;
  textBuf: string;
  /** Model reasoning, accumulated separately from the answer text. */
  thinkingBuf: string;
  /** Splits inline <think> tags out of the text stream. */
  splitter: ThinkTagSplitter;
  tools: ToolRecord[];
  /** Tool calls still waiting for their result. */
  openTools: Set<ToolRecord>;
  /** A tool ran since the last text — next text starts a new paragraph. */
  needSep: boolean;
  usage?: MessageUsage;
  modelUsed?: string;
  errorDetail?: string;
  stderrTail: string;
  stdoutBuf: string;
}

export class AgentManager {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly agents: AgentService,
    private readonly logger: Logger,
    private readonly emit: SessionEventEmitter,
  ) {}

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()];
  }

  /** Synchronous pre-flight used by the REST layer to return proper 409s. */
  canStart(session: Session): StartGate {
    if (this.active.has(session.id)) {
      return { ok: false, code: 'RUN_ACTIVE', message: 'A run is already active in this session.' };
    }
    const info = this.agents.infoOf(session.agentId);
    if (!info || !info.available) {
      const reason = info?.reason ?? 'not configured';
      return { ok: false, code: 'AGENT_UNAVAILABLE', message: `${info?.label ?? session.agentId} is not available: ${reason}` };
    }
    return { ok: true };
  }

  async startTurn(opts: StartTurnOptions): Promise<TurnOutcome> {
    const { session, project } = opts;
    const existing = this.active.get(session.id);
    if (existing) {
      return { ok: false, text: '', error: 'A run is already active in this session.' };
    }
    const adapter = this.agents.get(session.agentId);
    const info = this.agents.infoOf(session.agentId);
    if (!adapter || !info) {
      return this.failSession(session, `Agent ${session.agentId} is not configured.`);
    }
    if (!info.available) {
      return this.failSession(session, `${info.label} is not available: ${info.reason ?? 'unknown reason'}`);
    }
    if (!adapter.capabilities().headless) {
      await this.store.appendMessage(this.ideSystemMessage(session, info.label));
      return {
        ok: false,
        text: '',
        error: `${info.label} runs in IDE mode only — see the system message in this session.`,
      };
    }

    const attachments = [...opts.attachments];
    for (const att of attachments) {
      if (att.mime.startsWith('image/')) {
        try {
          att.base64 = (await fsp.readFile(att.path)).toString('base64');
        } catch (err) {
          this.logger.warn({ err, path: att.path }, 'failed to read image attachment');
        }
      }
    }

    const model = opts.model ?? session.model;
    const thinkingEffort = opts.thinkingEffort ?? session.thinkingEffort;
    const resumeId = adapter.supportsResume ? session.externalSessionId : undefined;
    let plan: RunPlan;
    try {
      plan = adapter.buildRun({
        session,
        project,
        text: opts.text,
        attachments,
        model,
        thinkingEffort,
        permissionMode: session.permissionMode,
        resumeId,
      });
    } catch (err) {
      return this.failSession(session, `Failed to build ${info.label} run: ${errorMessage(err)}`);
    }

    session.lastError = undefined;
    session.status = 'queued';
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'queued' });

    await ensureDir(project.path);

    // Account profile env (multi-account switching) wins over adapter env.
    const accountEnv = session.accountId ? this.store.getAccount(session.accountId)?.env : undefined;

    let child: Child;
    try {
      child = execa(plan.command, plan.args, {
        cwd: project.path,
        env: { ...process.env, ...(plan.env ?? {}), ...(accountEnv ?? {}) },
        stdin: plan.stdinPayloads ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false,
        reject: false,
        detached: true,
        cleanup: false,
      });
    } catch (err) {
      return this.failSession(session, `Failed to spawn ${plan.command}: ${errorMessage(err)}`);
    }

    const run: ActiveRun = {
      sessionId: session.id,
      session,
      adapter,
      plan,
      child,
      timer: setTimeout(() => undefined, 2 ** 31 - 1), // replaced below
      exited: false,
      interrupted: false,
      textBuf: '',
      thinkingBuf: '',
      splitter: new ThinkTagSplitter(),
      tools: [],
      openTools: new Set(),
      needSep: false,
      stderrTail: '',
      stdoutBuf: '',
    };
    this.active.set(session.id, run);

    run.timer = setTimeout(() => {
      this.interrupt(session.id, `Run exceeded the ${Math.round((opts.maxRunMs ?? this.config.maxRunMs) / 1000)}s limit`);
    }, opts.maxRunMs ?? this.config.maxRunMs);
    run.timer.unref?.();

    if (plan.notice) {
      this.emit(session.id, { type: 'raw', line: `[agentdeck] ${plan.notice}` });
    }

    if (child.stdin && plan.stdinPayloads) {
      for (const payload of plan.stdinPayloads) {
        child.stdin.write(payload + '\n');
      }
      child.stdin.end();
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdoutChunk(run, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      run.stderrTail = (run.stderrTail + chunk).slice(-4000);
    });

    session.status = 'running';
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'running' });

    let exitCode: number | undefined;
    let failed = false;
    try {
      const result = await child;
      exitCode = result.exitCode;
      failed = result.failed === true;
    } catch (err) {
      failed = true;
      run.stderrTail = (run.stderrTail + errorMessage(err)).slice(-4000);
    }

    run.exited = true;
    clearTimeout(run.timer);
    this.active.delete(session.id);

    const text = await this.flush(run);

    let status: SessionStatus;
    let error: string | undefined;
    if (run.interrupted) {
      status = 'stopped';
      error = run.errorDetail ?? 'Run interrupted';
    } else if (failed || exitCode !== 0 || run.errorDetail) {
      status = 'error';
      const tail = run.stderrTail.trim();
      const raw = run.errorDetail
        ?? (tail
          ? `${info.label} exited with code ${exitCode ?? 'signal'}: ${truncate(tail, 500)}`
          : `${info.label} exited with code ${exitCode ?? 'unknown'}`);
      // Actionable hint for the one recurring zcode setup gap.
      error = /select a model before continuing/i.test(raw)
        ? `${raw}\n\n→ Run \`zcode login zai\` once on this machine (opens the browser), then retry.`
        : raw;
    } else {
      status = 'idle';
    }

    if (run.externalId) session.externalSessionId = run.externalId;
    session.status = status;
    session.lastError = status === 'error' ? error : undefined;
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status });

    this.logger.info({ session: session.id, agent: session.agentId, status, exitCode }, 'run finished');
    return { ok: status !== 'error', text, error };
  }

  /** SIGINT (graceful) now, SIGKILL after 3s if still alive. Returns false when nothing active. */
  interrupt(sessionId: string, reason?: string): boolean {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.interrupted = true;
    if (reason && !run.errorDetail) run.errorDetail = reason;
    killTree(run.child.pid, 'SIGINT');
    const killTimer = setTimeout(() => {
      if (!run.exited) {
        killTree(run.child.pid, 'SIGKILL');
        try {
          run.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 3000);
    killTimer.unref?.();
    this.logger.info({ session: sessionId }, 'interrupting run');
    return true;
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.interrupt(id, 'Server shutting down');
  }

  // -------------------------------------------------------------------------

  private onStdoutChunk(run: ActiveRun, chunk: string): void {
    run.stdoutBuf += chunk;
    for (;;) {
      const idx = run.stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = run.stdoutBuf.slice(0, idx);
      run.stdoutBuf = run.stdoutBuf.slice(idx + 1);
      this.handleLine(run, line);
    }
  }

  private handleLine(run: ActiveRun, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const externalId = run.adapter.externalSessionIdOf?.(trimmed);
    if (externalId && externalId !== run.externalId) {
      run.externalId = externalId;
    }
    try {
      run.plan.parse(trimmed, (event) => this.onAgentEvent(run, event));
    } catch (err) {
      this.logger.warn({ err, session: run.sessionId }, 'adapter parse error');
      this.emit(run.sessionId, { type: 'raw', line: trimmed });
    }
  }

  private onAgentEvent(run: ActiveRun, event: AgentEvent): void {
    switch (event.type) {
      case 'text-delta':
        this.onText(run, run.splitter.push(event.text));
        return;
      case 'thinking-delta':
        run.thinkingBuf += event.text;
        break;
      case 'tool-use':
        {
          const rec: ToolRecord = { tool: event.tool, ok: true, ...(event.summary ? { summary: event.summary } : {}) };
          run.tools.push(rec);
          run.openTools.add(rec);
        }
        run.needSep = true;
        break;
      case 'tool-result': {
        const open = [...run.openTools].find((t) => t.tool === event.tool);
        if (open) {
          open.ok = event.ok;
          if (event.summary) open.summary = event.summary;
          run.openTools.delete(open);
        } else {
          run.tools.push({ tool: event.tool, ok: event.ok, ...(event.summary ? { summary: event.summary } : {}) });
        }
        break;
      }
      case 'usage': {
        run.usage = {
          inputTokens: event.inputTokens ?? run.usage?.inputTokens,
          outputTokens: event.outputTokens ?? run.usage?.outputTokens,
          costUsd: event.costUsd ?? run.usage?.costUsd,
        };
        if (event.model) run.modelUsed = event.model;
        break;
      }
      case 'status':
        if (event.status === 'error' && event.detail && !run.errorDetail) {
          run.errorDetail = event.detail;
        }
        break;
      default:
        break; // tool-*/raw/message events are broadcast-only
    }
    this.emit(run.sessionId, event);
  }

  /** Routes split text/thinking parts into the buffers and broadcasts them. */
  private onText(run: ActiveRun, parts: ThinkPart[]): void {
    for (const part of parts) {
      if (part.kind === 'thinking') {
        run.thinkingBuf += part.text;
        this.emit(run.sessionId, { type: 'thinking-delta', text: part.text });
        continue;
      }
      let text = part.text;
      if (run.needSep && run.textBuf.trim() && !/\n\s*$/.test(run.textBuf) && text.trim()) text = '\n\n' + text;
      if (text.trim()) run.needSep = false;
      run.textBuf += text;
      this.emit(run.sessionId, { type: 'text-delta', text });
    }
  }

  /** Persists buffered text+thinking as one assistant ChatMessage and clears the buffers. */
  private async flush(run: ActiveRun): Promise<string> {
    this.onText(run, run.splitter.end());
    const text = run.textBuf;
    const thinking = run.thinkingBuf;
    const tools = run.tools;
    run.tools = [];
    if (!text.trim() && !thinking.trim() && tools.length === 0) {
      run.textBuf = '';
      run.thinkingBuf = '';
      run.usage = undefined;
      return '';
    }
    const message: ChatMessage = {
      id: newMessageId(),
      sessionId: run.sessionId,
      role: 'assistant',
      agentId: run.session.agentId,
      ...(run.modelUsed ? { model: run.modelUsed } : run.session.model ? { model: run.session.model } : {}),
      text,
      ...(thinking.trim() ? { thinking } : {}),
      ...(tools.length ? { tools } : {}),
      attachments: [],
      ts: Date.now(),
      ...(run.usage ? { usage: run.usage } : {}),
    };
    run.textBuf = '';
    run.thinkingBuf = '';
    run.usage = undefined;
    await this.store.appendMessage(message);
    return text;
  }

  private async failSession(session: Session, reason: string): Promise<TurnOutcome> {
    session.status = 'error';
    session.lastError = reason;
    await this.store.saveSession(session);
    this.emit(session.id, { type: 'status', status: 'error', detail: reason });
    return { ok: false, text: '', error: reason };
  }

  private ideSystemMessage(session: Session, label: string): ChatMessage {
    const text = [
      `${label} runs in IDE mode on this machine — it cannot be driven headlessly from the app.`,
      '',
      'How to work with it:',
      `• Open the project in the IDE: POST /api/sessions/${session.id}/ide (the "Open in IDE" action).`,
      '• Delegate tasks across agents via the MCP bridge: register the `agentdeck-mcp` binary',
      '  (shipped with this server) as an MCP server inside the IDE agent. It exposes',
      '  `agentdeck_list_agents`, `agentdeck_delegate` and `agentdeck_project_files`, so the',
      '  IDE agent can hand work to headless agents (Claude Code, Codex) on this machine.',
      '',
      'Your message is saved above and stays in this session’s history.',
    ].join('\n');
    return {
      id: newMessageId(),
      sessionId: session.id,
      role: 'system',
      agentId: session.agentId,
      text,
      attachments: [],
      ts: Date.now(),
    };
  }
}

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
    // already dead
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
