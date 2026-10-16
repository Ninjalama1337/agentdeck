import type { AgentCapabilities, AgentEvent, AgentId, ModelPreset } from '@agentdeck/shared';
import { execa } from 'execa';
import type { ResolvedAgentConfig } from '../config.js';
import { splitCommand } from '../util/cmd.js';
import { withTimeoutFallback } from '../util/async.js';
import { MODEL_PRESETS } from './models.js';
import {
  resolveModelArg,
  summarizeInput,
  type AgentAdapter,
  type DetectResult,
  type RunContext,
  type RunPlan,
} from './types.js';

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    title?: string;
    error?: string;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  part?: OpenCodePart;
  error?: unknown;
}

/**
 * Parses `opencode run --format json` (one JSON event per line). Text and
 * reasoning parts stream; a repeated part id carries the full text again, so
 * only the new suffix is emitted. Tool parts report a state that flips to
 * `completed`/`error`; tokens and cost accumulate across steps.
 */
export function createOpenCodeStreamParser() {
  const textByPart = new Map<string, number>();
  const thinkByPart = new Map<string, number>();
  const usedTools = new Set<string>();
  const doneTools = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;

  const emitSuffix = (
    emit: (event: AgentEvent) => void,
    kind: 'text' | 'thinking',
    id: string,
    full: string,
  ): void => {
    const seen = kind === 'text' ? textByPart : thinkByPart;
    const already = seen.get(id) ?? 0;
    if (full.length <= already) return;
    const delta = full.slice(already);
    seen.set(id, full.length);
    emit(kind === 'text' ? { type: 'text-delta', text: delta } : { type: 'thinking-delta', text: delta });
  };

  return {
    parse(line: string, emit: (event: AgentEvent) => void): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: OpenCodeEvent;
      try {
        event = JSON.parse(trimmed) as OpenCodeEvent;
      } catch {
        emit({ type: 'raw', line: trimmed });
        return;
      }
      const part = event.part ?? {};
      switch (event.type) {
        case 'text':
          if (typeof part.text === 'string' && part.text) emitSuffix(emit, 'text', part.id ?? '', part.text);
          break;
        case 'reasoning':
          if (typeof part.text === 'string' && part.text) emitSuffix(emit, 'thinking', part.id ?? '', part.text);
          break;
        case 'tool_use': {
          const callID = part.callID ?? part.id ?? '';
          const tool = part.tool ?? 'tool';
          const state = part.state ?? {};
          const summary = summarizeInput(state.input) ?? state.title;
          if (callID && !usedTools.has(callID)) {
            usedTools.add(callID);
            emit({ type: 'tool-use', tool, ...(summary ? { summary } : {}) });
          }
          if ((state.status === 'completed' || state.status === 'error') && callID && !doneTools.has(callID)) {
            doneTools.add(callID);
            const resultSummary = state.title ?? summary;
            emit({ type: 'tool-result', tool, ok: state.status !== 'error', ...(resultSummary ? { summary: resultSummary } : {}) });
          }
          break;
        }
        case 'step_finish': {
          const tokens = part.tokens;
          if (tokens) {
            inputTokens += tokens.input ?? 0;
            outputTokens += tokens.output ?? 0;
            cacheReadTokens += tokens.cache?.read ?? 0;
            cacheWriteTokens += tokens.cache?.write ?? 0;
          }
          if (typeof part.cost === 'number') costUsd += part.cost;
          if (tokens || typeof part.cost === 'number') {
            emit({ type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd });
          }
          break;
        }
        case 'error': {
          const detail = typeof event.error === 'string' ? event.error : undefined;
          emit({ type: 'status', status: 'error', ...(detail ? { detail } : {}) });
          break;
        }
        default:
          break;
      }
    },
  };
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: AgentId = 'opencode';
  readonly label = 'OpenCode';
  readonly kind = 'cli' as const;
  readonly accentColor = '#F59E0B';
  readonly supportsResume = true;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    try {
      const res = await withTimeoutFallback(execa(bin, ['--version'], { reject: false }), 5000, null, 'opencode --version');
      if (!res || res.exitCode !== 0) {
        return { available: false, reason: `opencode CLI not runnable (command: ${bin})` };
      }
      const version = /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1];
      return { available: true, version };
    } catch {
      return { available: false, reason: `opencode CLI not found (command: ${bin})` };
    }
  }

  capabilities(): AgentCapabilities {
    return {
      headless: this.cfg.mode === 'off' ? false : this.cfg.mode !== 'ide',
      images: true,
      resume: true,
      streaming: true,
      ideLaunch: false,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.opencode;
  }

  externalSessionIdOf(line: string): string | undefined {
    try {
      const event = JSON.parse(line.trim()) as OpenCodeEvent;
      return typeof event.sessionID === 'string' ? event.sessionID : undefined;
    } catch {
      return undefined;
    }
  }

  buildRun(ctx: RunContext): RunPlan {
    const args: string[] = ['run', '--format', 'json'];
    if (ctx.permissionMode === 'bypass') args.push('--auto');
    const model = resolveModelArg(ctx.model);
    if (model) args.push('-m', model);
    if (ctx.resumeId) args.push('-s', ctx.resumeId);
    for (const att of ctx.attachments) args.push(`--file=${att.path}`);
    // `--` keeps the prompt out of the greedy `--file` list.
    args.push('--', ctx.text);

    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const parser = createOpenCodeStreamParser();

    return {
      command: bin,
      args: [...prefixArgs, ...args],
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
    };
  }
}
