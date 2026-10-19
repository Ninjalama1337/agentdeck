/**
 * Config-driven CLI agent (Orca's "works with any CLI agent").
 *
 * Runs a one-shot command from `agents.custom` headlessly: the fixed flags go
 * in `command`, `promptArg` says where the prompt goes (`{prompt}`), `modelArg`
 * optionally says where the session model goes (`{model}`), and stdout
 * is streamed as plain text — no output schema is guessed, so any CLI that can
 * answer one prompt works. Off by default; enable it in the config.
 */
import type { AgentCapabilities, AgentEvent, AgentId, ModelPreset } from '@agentdeck/shared';
import { execa } from 'execa';
import type { ResolvedAgentConfig } from '../config.js';
import { splitCommand } from '../util/cmd.js';
import { withTimeoutFallback } from '../util/async.js';
import { MODEL_PRESETS } from './models.js';
import type { AgentAdapter, DetectResult, RunContext, RunPlan } from './types.js';
import { resolveModelArg } from './types.js';

/** ANSI SGR/CSI sequences a CLI may keep even when its output is a pipe. */
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Plain-text stdout: every non-empty line becomes a text delta with its line
 * break, so markdown and code blocks survive.
 */
export function createCustomTextParser() {
  return {
    parse(line: string, emit: (event: AgentEvent) => void): void {
      const text = line.replace(ANSI, '');
      if (text.trim()) emit({ type: 'text-delta', text: `${text}\n` });
    },
  };
}

export class CustomCliAdapter implements AgentAdapter {
  readonly id: AgentId = 'custom';
  readonly label = 'Custom CLI';
  readonly kind = 'cli' as const;
  readonly accentColor = '#8B5CF6';
  readonly supportsResume = false;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    try {
      const res = await withTimeoutFallback(
        execa(bin, ['--version'], { reject: false }),
        5000,
        null,
        'custom agent --version',
      );
      // A CLI without `--version` still answers with a non-zero exit — it ran,
      // so the command exists. Only a spawn failure (ENOENT) means missing.
      if (!res) return { available: true };
      const version = /(\d+\.\d+\.\d+)/.exec(`${res.stdout}\n${res.stderr}`)?.[1];
      return version ? { available: true, version } : { available: true };
    } catch {
      return { available: false, reason: `Command not runnable (command: ${bin})` };
    }
  }

  capabilities(): AgentCapabilities {
    return {
      headless: this.cfg.mode === 'off' ? false : this.cfg.mode !== 'ide',
      images: false,
      resume: false,
      streaming: true,
      ideLaunch: false,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.custom;
  }

  buildRun(ctx: RunContext): RunPlan {
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const args: string[] = [...prefixArgs];

    const parts: string[] = [ctx.text];
    for (const att of ctx.attachments) parts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    const prompt = parts.join('\n');

    // Model flag first: it is a fixed option, while the prompt is usually the
    // trailing positional argument. Uses the same substitution rules as
    // promptArg, so flags stay one argv element (`--model={model}`).
    const modelArg = this.cfg.modelArg?.trim() ?? '';
    const model = resolveModelArg(ctx.model);
    if (model && modelArg) {
      const modelTokens = modelArg.split(/\s+/).filter(Boolean);
      if (modelTokens.some((token) => token.includes('{model}'))) {
        for (const token of modelTokens) args.push(token.split('{model}').join(model));
      } else {
        // No placeholder: the template is the flag, the model its value.
        args.push(...modelTokens, model);
      }
    }

    const promptArg = this.cfg.promptArg ?? '{prompt}';
    const tokens = promptArg.trim() ? promptArg.trim().split(/\s+/).filter(Boolean) : [];
    let stdinPrompt: string | null = null;
    if (tokens.length === 0) {
      stdinPrompt = prompt;
    } else if (tokens.some((token) => token.includes('{prompt}'))) {
      // The placeholder may be embedded (`--message={prompt}`): stay one argv element.
      for (const token of tokens) args.push(token.split('{prompt}').join(prompt));
    } else {
      args.push(...tokens, prompt);
    }

    const parser = createCustomTextParser();
    return {
      command: bin,
      args,
      stdinPayloads: stdinPrompt !== null ? [stdinPrompt] : null,
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
    };
  }
}
