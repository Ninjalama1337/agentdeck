/**
 * Claude Code adapter — fully headless via stream-json (facts verified in
 * CONTRACT.md): `claude -p --input-format stream-json --output-format
 * stream-json --verbose`, `--model`, `--permission-mode`, `--resume`.
 */
import type { AgentCapabilities, AgentEvent, AgentId, ModelPreset } from '@agentdeck/shared';
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

const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions',
};

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_cost_usd?: number;
  };
  message?: {
    role?: string;
    content?: unknown;
  };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude';
  readonly label = 'Claude Code';
  readonly kind = 'cli' as const;
  readonly accentColor = '#FF6A3D';
  readonly supportsResume = true;
  readonly efforts = AGENT_EFFORTS;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    try {
      const res = await withTimeoutFallback(execa(bin, ['--version'], { reject: false }), 5000, null, 'claude --version');
      if (!res || res.exitCode !== 0) {
        return { available: false, reason: `claude CLI not runnable (command: ${bin})` };
      }
      const version = /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1];
      return { available: true, version };
    } catch {
      return { available: false, reason: `claude CLI not found (command: ${bin})` };
    }
  }

  capabilities(): AgentCapabilities {
    return {
      // claude/codex are CLI agents: only an explicit 'ide' mode disables headless.
      headless: this.cfg.mode === 'off' ? false : this.cfg.mode !== 'ide',
      images: true,
      resume: true,
      streaming: true,
      ideLaunch: false,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.claude;
  }

  buildRun(ctx: RunContext): RunPlan {
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const args: string[] = [...prefixArgs];
    const model = resolveModelArg(ctx.model);
    const promptParts: string[] = [ctx.text];
    const images: { media_type: string; data: string }[] = [];

    for (const att of ctx.attachments) {
      if (att.mime.startsWith('image/') && att.base64) {
        images.push({ media_type: att.mime, data: att.base64 });
      } else {
        promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
      }
    }

    args.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
    if (model) args.push('--model', model);
    args.push('--permission-mode', PERMISSION_MODE_MAP[ctx.permissionMode] ?? 'default');
    const effort = effortArg(ctx.thinkingEffort);
    if (effort) args.push('--effort', effort);
    if (ctx.resumeId) args.push('--resume', ctx.resumeId);

    const content: unknown[] = [{ type: 'text', text: promptParts.join('\n') }];
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content } });

    const parser = createClaudeStreamParser();
    return {
      command: bin,
      args,
      stdinPayloads: [payload],
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
    };
  }

  externalSessionIdOf(line: string): string | undefined {
    const parsed = safeJson(line) as ClaudeStreamLine | undefined;
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string') {
      return parsed.session_id;
    }
    return undefined;
  }
}

export function createClaudeStreamParser() {
  const toolNames = new Map<string, string>();
  let sawTextDelta = false;

  function parse(line: string, emit: (event: AgentEvent) => void): void {
    const parsed = safeJson(line) as ClaudeStreamLine | undefined;
    if (!parsed || typeof parsed !== 'object') {
      if (line.trim()) emit({ type: 'raw', line });
      return;
    }

    switch (parsed.type) {
      case 'system': {
        if (parsed.subtype === 'init') {
          emit({ type: 'status', status: 'running', detail: 'Claude Code session initialized' });
        }
        return;
      }
      case 'assistant': {
        const content = parsed.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            sawTextDelta = true;
            emit({ type: 'text-delta', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            // Reasoning stays strictly separate from the answer text.
            emit({ type: 'thinking-delta', text: block.thinking });
          } else if (block.type === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : undefined;
            const name = typeof block.name === 'string' ? block.name : 'tool';
            if (id) toolNames.set(id, name);
            emit({
              type: 'tool-use',
              tool: name,
              summary: summarizeInput(block.input),
            });
          }
        }
        return;
      }
      case 'user': {
        const content = parsed.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'tool_result') {
            const tool = typeof block.tool_use_id === 'string' ? (toolNames.get(block.tool_use_id) ?? 'tool') : 'tool';
            emit({
              type: 'tool-result',
              tool,
              ok: block.is_error !== true,
              summary: summarizeInput(block.content),
            });
          }
        }
        return;
      }
      case 'result': {
        const usage = parsed.usage;
        const costUsd = parsed.total_cost_usd ?? usage?.total_cost_usd;
        if (usage || costUsd !== undefined) {
          emit({
            type: 'usage',
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            costUsd,
          });
        }
        if (parsed.is_error === true || parsed.subtype === 'error_during_execution' || parsed.subtype === 'error') {
          const detail = typeof parsed.result === 'string' ? parsed.result : (parsed.subtype ?? 'error');
          emit({ type: 'status', status: 'error', detail });
        } else if (!sawTextDelta && typeof parsed.result === 'string' && parsed.result.trim()) {
          // Defensive: some runs deliver the final text only in the result event.
          emit({ type: 'text-delta', text: truncate(parsed.result, 100_000) });
        }
        return;
      }
      default:
        emit({ type: 'raw', line });
    }
  }

  return { parse };
}

export function safeJson(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
