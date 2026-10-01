import type { AgentCapabilities, AgentEvent, AgentId, ModelPreset } from '@agentdeck/shared';
import { execa } from 'execa';
import type { ResolvedAgentConfig } from '../config.js';
import { splitCommand } from '../util/cmd.js';
import { withTimeoutFallback } from '../util/async.js';
import { MODEL_PRESETS } from './models.js';
import {
  resolveModelArg,
  type AgentAdapter,
  type DetectResult,
  type RunContext,
  type RunPlan,
} from './types.js';

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
      images: false,
      resume: true,
      streaming: true,
      ideLaunch: false,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.opencode;
  }

  buildRun(ctx: RunContext): RunPlan {
    const args: string[] = ['run'];
    const model = resolveModelArg(ctx.model);
    if (model) args.push('-m', model);
    if (ctx.resumeId) {
      args.push('-s', ctx.resumeId);
    }
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    args.push(ctx.text);

    return {
      command: bin,
      args: [...prefixArgs, ...args],
      stdinPayloads: null,
      expectStream: false,
      parse: (line: string, emit: (event: AgentEvent) => void) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'text' && typeof parsed.content === 'string') {
            emit({ type: 'text-delta', text: parsed.content });
          } else if (parsed.content) {
            emit({ type: 'text-delta', text: String(parsed.content) });
          }
        } catch {
          emit({ type: 'text-delta', text: line + '\n' });
        }
      },
    };
  }
}
