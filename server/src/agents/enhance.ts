/**
 * Transient one-shot agent run for "Enhance prompt" (BridgeMind port):
 * rewrites a rough draft into a crisp prompt WITHOUT creating a session or
 * persisting any messages.
 */
import { execa } from 'execa';
import type { AgentEvent, AgentId, Project, Session } from '@agentdeck/shared';
import type { AgentService } from './registry.js';
import type { Logger } from '../logging.js';
import { truncate } from './types.js';

const ENHANCE_TIMEOUT_MS = 60_000;

const META_PROMPT = [
  'You improve prompts for a coding agent. Rewrite the rough draft below into ONE crisp,',
  'self-contained instruction: minimal context, a concrete deliverable, explicit constraints.',
  'Preserve the author\'s language. Reply with the improved prompt ONLY — no preamble, no',
  'quotation marks, no explanation.',
  '',
  'Draft:',
  '<<<',
].join('\n');

export interface EnhanceArgs {
  project: Project;
  agentId: AgentId;
  text: string;
  model?: string;
  thinkingEffort?: string;
  accountId?: string;
}

export interface EnhanceRunnerDeps {
  agents: AgentService;
  store: { getAccount(id: string): { env: Record<string, string> } | undefined };
  log: Logger;
}

export class EnhanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Runs the enhance meta-prompt through the chosen agent; returns its answer text. */
export async function runEnhance(deps: EnhanceRunnerDeps, args: EnhanceArgs): Promise<string> {
  const adapter = deps.agents.get(args.agentId);
  const info = deps.agents.infoOf(args.agentId);
  if (!adapter || !info) throw new EnhanceError(`Agent ${args.agentId} is not configured.`, 'AGENT_UNAVAILABLE');
  if (!info.available) {
    throw new EnhanceError(`${info.label} is not available: ${info.reason ?? 'unknown reason'}`, 'AGENT_UNAVAILABLE');
  }
  if (!adapter.capabilities().headless) {
    throw new EnhanceError(`${info.label} runs in IDE mode only.`, 'AGENT_UNAVAILABLE');
  }

  const transient: Session = {
    id: 'enhance',
    projectId: args.project.id,
    agentId: args.agentId,
    title: 'enhance',
    status: 'running',
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.thinkingEffort !== undefined ? { thinkingEffort: args.thinkingEffort } : {}),
    ...(args.accountId ? { accountId: args.accountId } : {}),
    permissionMode: 'default',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  let plan;
  try {
    plan = adapter.buildRun({
      session: transient,
      project: args.project,
      text: `${META_PROMPT}\n${truncate(args.text, 8_000)}\n>>>`,
      attachments: [],
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.thinkingEffort !== undefined ? { thinkingEffort: args.thinkingEffort } : {}),
      permissionMode: 'default',
    });
  } catch (err) {
    throw new EnhanceError(`Failed to build ${info.label} run: ${err instanceof Error ? err.message : String(err)}`, 'RUN_FAILED');
  }

  const accountEnv = args.accountId ? deps.store.getAccount(args.accountId)?.env : undefined;

  return await new Promise<string>((resolve, reject) => {
    let text = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: EnhanceError, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve((result ?? '').trim());
    };

    let child: ReturnType<typeof execa>;
    try {
      child = execa(plan.command, plan.args, {
        cwd: args.project.path,
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
      finish(new EnhanceError(`Failed to spawn ${plan.command}: ${err instanceof Error ? err.message : String(err)}`, 'RUN_FAILED'));
      return;
    }

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      finish(new EnhanceError('Enhance timed out after 60s.', 'TIMEOUT'));
    }, ENHANCE_TIMEOUT_MS);
    timer.unref?.();

    if (child.stdin && plan.stdinPayloads) {
      for (const payload of plan.stdinPayloads) child.stdin.write(payload + '\n');
      child.stdin.end();
    }

    let stdoutBuf = '';
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'text-delta') text += event.text;
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      for (;;) {
        const idx = stdoutBuf.indexOf('\n');
        if (idx < 0) break;
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          plan.parse(line, onEvent);
        } catch (err) {
          deps.log.warn({ err }, 'enhance parse error');
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    void child
      .then((result) => {
        if (result.failed || result.exitCode !== 0) {
          finish(
            new EnhanceError(
              `${info.label} exited with code ${result.exitCode ?? 'signal'}${stderr.trim() ? `: ${truncate(stderr.trim(), 300)}` : ''}`,
              'RUN_FAILED',
            ),
          );
          return;
        }
        if (!text.trim()) {
          finish(new EnhanceError(`${info.label} returned no text.`, 'EMPTY'));
          return;
        }
        finish(undefined, text);
      })
      .catch((err) => {
        finish(new EnhanceError(err instanceof Error ? err.message : String(err), 'RUN_FAILED'));
      });
  });
}
