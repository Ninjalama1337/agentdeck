/**
 * Codex adapter — headless via `codex exec --json` (JSONL events on stdout),
 * `-C <dir>` sets the project, `-m <model>`, resume: `codex exec resume <id>`.
 * The event schema has shifted between codex releases, so the parser is
 * deliberately defensive: anything unrecognized is re-emitted as a raw event
 * so no output is ever lost.
 */
import type { AgentCapabilities, AgentEvent, AgentId, ModelPreset, PlanItem } from '@agentdeck/shared';
import { execa } from 'execa';
import type { ResolvedAgentConfig } from '../config.js';
import { splitCommand } from '../util/cmd.js';
import { withTimeoutFallback } from '../util/async.js';
import { MODEL_PRESETS } from './models.js';
import { AGENT_EFFORTS, effortArg } from './effort.js';
import {
  resolveModelArg,
  summarizeInput,
  truncate,
  type AgentAdapter,
  type DetectResult,
  type RunContext,
  type RunPlan,
} from './types.js';
import { safeJson } from './claude.js';
import { isPlanTool, planItemsOf } from './plan.js';

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = 'codex';
  readonly label = 'Codex';
  readonly kind = 'cli' as const;
  readonly accentColor = '#10B981';
  readonly supportsResume = true;
  readonly efforts = AGENT_EFFORTS;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    try {
      const res = await withTimeoutFallback(execa(bin, ['--version'], { reject: false }), 5000, null, 'codex --version');
      if (!res || res.exitCode !== 0) {
        return { available: false, reason: `codex CLI not runnable (command: ${bin})` };
      }
      const version = /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1];
      return { available: true, version };
    } catch {
      return { available: false, reason: `codex CLI not found (command: ${bin})` };
    }
  }

  capabilities(): AgentCapabilities {
    return {
      headless: this.cfg.mode === 'off' ? false : this.cfg.mode !== 'ide',
      images: false,
      resume: true,
      streaming: true,
      ideLaunch: false,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.codex;
  }

  buildRun(ctx: RunContext): RunPlan {
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const args: string[] = [...prefixArgs];
    const promptParts: string[] = [ctx.text];
    for (const att of ctx.attachments) {
      promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    }
    const prompt = promptParts.join('\n');

    if (ctx.resumeId) {
      args.push('exec', 'resume', ctx.resumeId, '--json');
    } else {
      args.push('exec', '--json');
    }
    args.push('-C', ctx.project.path);
    const model = resolveModelArg(ctx.model);
    if (model) args.push('-m', model);
    const effort = effortArg(ctx.thinkingEffort);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(prompt);

    const parser = createCodexStreamParser();
    return {
      command: bin,
      args,
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
    };
  }

  externalSessionIdOf(line: string): string | undefined {
    const parsed = safeJson(line) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== 'object') return undefined;
    for (const key of ['thread_id', 'session_id', 'threadId', 'sessionId']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  }
}

interface CodexItem {
  type?: string;
  id?: string;
  text?: string;
  message?: string;
  command?: string;
  exit_code?: number;
  status?: string;
  name?: string;
  tool?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** A Codex plan item, or a plan-tool call, as checklist entries. */
function planOfItem(item: CodexItem | undefined): PlanItem[] | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (item.type === 'plan' || item.type === 'todo_list' || item.type === 'todo') return planItemsOf(item);
  const name = typeof item.name === 'string' ? item.name : typeof item.tool === 'string' ? item.tool : undefined;
  if (name && isPlanTool(name)) {
    const raw = item.arguments ?? item.input;
    let args: unknown = raw;
    if (typeof raw === 'string') {
      try {
        args = JSON.parse(raw);
      } catch {
        args = undefined;
      }
    }
    return planItemsOf(args ?? item);
  }
  return undefined;
}

function textFromItem(item: CodexItem): string | undefined {
  if (typeof item.text === 'string' && item.text) return item.text;
  if (typeof item.message === 'string' && item.message) return item.message;
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content as Record<string, unknown>[]) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

/** Finds the first object holding numeric input_tokens/output_tokens. */
function findUsage(value: unknown, depth = 0): { inputTokens?: number; outputTokens?: number } | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const input = obj['input_tokens'];
  const output = obj['output_tokens'];
  if (typeof input === 'number' || typeof output === 'number') {
    return {
      inputTokens: typeof input === 'number' ? input : undefined,
      outputTokens: typeof output === 'number' ? output : undefined,
    };
  }
  for (const child of Object.values(obj)) {
    const found = findUsage(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function createCodexStreamParser() {
  let completedItems = new Set<string>();

  function parse(line: string, emit: (event: AgentEvent) => void): void {
    const parsed = safeJson(line) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== 'object') {
      if (line.trim()) emit({ type: 'raw', line });
      return;
    }
    const type = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;

    // Usage can ride on turn.completed, event_msg token_count payloads, etc.
    if (type === 'turn.completed' || type === 'token_count' || /token_count|usage/.test(type ?? '')) {
      const usage = findUsage(parsed);
      if (usage) emit({ type: 'usage', ...usage });
      if (type === 'turn.completed') return;
    }

    // Legacy shape: {"msg": {"type": "agent_message", "message": "..."}}
    const msg = parsed['msg'] as Record<string, unknown> | undefined;
    if (msg && typeof msg === 'object') {
      if (msg['type'] === 'agent_message' && typeof msg['message'] === 'string') {
        emit({ type: 'text-delta', text: truncate(msg['message'], 100_000) });
        return;
      }
      if (msg['type'] === 'task_complete') return;
      if (msg['type'] === 'error' || msg['type'] === 'stream_error') {
        emit({ type: 'status', status: 'error', detail: String(msg['message'] ?? 'codex error') });
        return;
      }
    }

    switch (type) {
      case 'thread.started':
      case 'session.started':
      case 'turn.started':
        return;
      case 'error':
      case 'turn.failed':
      case 'stream_error': {
        const detail =
          typeof parsed['message'] === 'string' ? parsed['message'] : JSON.stringify(parsed).slice(0, 300);
        emit({ type: 'status', status: 'error', detail });
        return;
      }
      case 'turn.completed':
      case 'turn.aborted':
      case 'task_complete':
        return;
      case 'item.started':
      case 'item.updated': {
        const item = parsed['item'] as CodexItem | undefined;
        const plan = planOfItem(item);
        if (plan) {
          emit({ type: 'plan', items: plan });
          return;
        }
        if (item && item.type === 'command_execution' && typeof item.command === 'string') {
          emit({ type: 'tool-use', tool: item.type, summary: summarizeInput(item.command) });
        }
        return;
      }
      case 'item.completed': {
        const item = parsed['item'] as CodexItem | undefined;
        if (!item || typeof item !== 'object') {
          emit({ type: 'raw', line });
          return;
        }
        const plan = planOfItem(item);
        if (plan) {
          emit({ type: 'plan', items: plan });
          return;
        }
        const text = textFromItem(item);
        if (text) {
          emit({ type: 'text-delta', text: truncate(text, 100_000) });
          return;
        }
        if (item.type === 'command_execution') {
          const ok = item.exit_code === undefined ? item.status !== 'failed' : item.exit_code === 0;
          emit({
            type: 'tool-result',
            tool: 'command_execution',
            ok,
            summary: summarizeInput(item.command ?? item.aggregated_output ?? undefined),
          });
          return;
        }
        if (item.type === 'mcp_tool_call') {
          emit({ type: 'tool-use', tool: String(item.tool ?? item.name ?? 'mcp_tool_call'), summary: summarizeInput(item) });
          return;
        }
        if (item.type === 'reasoning') {
          // Codex reasoning summaries — separated from the answer text.
          const summary =
            (Array.isArray(item.summary) ? item.summary : undefined)
              ?.map((s: Record<string, unknown>) => (typeof s.text === 'string' ? s.text : ''))
              .filter(Boolean)
              .join('\n') ?? (typeof item.text === 'string' ? item.text : '');
          if (summary) emit({ type: 'thinking-delta', text: truncate(summary, 100_000) });
          return;
        }
        // reasoning / plan / unknown items stay silent unless nothing at all
        // has been emitted for this id yet — avoid dropping fresh shapes.
        const id = typeof item.id === 'string' ? item.id : '';
        if (id && !completedItems.has(id) && item.type && !['reasoning', 'plan', 'web_search'].includes(item.type)) {
          completedItems.add(id);
          emit({ type: 'raw', line });
        }
        return;
      }
      case 'message':
      case 'agent_message': {
        const text = textFromItem(parsed as CodexItem);
        if (text) emit({ type: 'text-delta', text: truncate(text, 100_000) });
        else emit({ type: 'raw', line });
        return;
      }
      default:
        emit({ type: 'raw', line });
    }
  }

  return { parse, reset: () => (completedItems = new Set()) };
}
