/**
 * Antigravity adapter.
 *
 * Supports:
 * - Headless CLI via `agy`:
 *   `agy -p <prompt> --output-format stream-json`
 *   with `--conversation <id>` for session continuity, `--effort <low|medium|high|max>`,
 *   `--mode <accept-edits|plan>`, and `--dangerously-skip-permissions`.
 * - Stream format is NDJSON SessionEvents (`init`, `step_update`, `result`).
 * - IDE mode via Flatpak `com.google.Antigravity` or native launcher.
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
import { safeJson } from './claude.js';

const FLATPAK_APP = 'com.google.Antigravity';

interface AntigravityStreamLine {
  event?: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: 'ACTIVE' | 'DONE';
    step_type?: 'user_input' | 'agent_response' | 'tool' | 'system_message';
    text_delta?: string;
    thinking_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: unknown;
    };
    error?: string;
    duration_seconds?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: 'SUCCESS' | 'ERROR';
    response?: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id: AgentId = 'antigravity';
  readonly label = 'Antigravity';
  readonly kind = 'cli' as const;
  readonly accentColor = '#4E8CFF';
  readonly supportsResume = true;
  readonly efforts = AGENT_EFFORTS;

  private cliDetected = false;
  private ideDetected = false;
  private resolvedCliBin = 'agy';

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    this.cliDetected = false;
    this.ideDetected = false;

    // 1. Probe the CLI binary (either configured command or fallback 'agy')
    const candidates = [bin, 'agy'].filter(
      (cmd, idx, arr) => arr.indexOf(cmd) === idx && !cmd.includes('com.google.Antigravity'),
    );
    let cliVersion: string | undefined;

    for (const cmd of candidates) {
      try {
        const res = await withTimeoutFallback(
          execa(cmd, ['--version'], { reject: false }),
          5000,
          null,
          `${cmd} --version`,
        );
        if (res && res.exitCode === 0) {
          const match = /(\d+\.\d+\.\d+)/.exec(res.stdout ?? '');
          cliVersion = match?.[1] ?? res.stdout?.trim();
          this.cliDetected = true;
          this.resolvedCliBin = cmd;
          break;
        }
      } catch {
        // next candidate
      }
    }

    // 2. Probe Flatpak IDE app existence
    let ideVersion: string | undefined;
    try {
      const res = await withTimeoutFallback(
        execa('flatpak', ['info', FLATPAK_APP], { reject: false }),
        5000,
        null,
        'flatpak info',
      );
      if (res && res.exitCode === 0) {
        this.ideDetected = true;
        ideVersion = /Version:\s*(\S+)/i.exec(res.stdout ?? '')?.[1];
      }
    } catch {
      // flatpak not available
    }

    if (this.cliDetected) {
      return { available: true, version: cliVersion };
    }

    if (this.ideDetected) {
      return { available: true, version: ideVersion, reason: 'IDE mode — agy CLI not found' };
    }

    return {
      available: false,
      reason: `Antigravity CLI (agy) not found and Flatpak ${FLATPAK_APP} not installed`,
    };
  }

  capabilities(): AgentCapabilities {
    const headless = this.cliDetected || this.cfg.mode === 'headless';
    return {
      headless: this.cfg.mode === 'off' ? false : this.cfg.mode === 'ide' ? false : headless,
      images: false,
      resume: headless,
      streaming: headless,
      ideLaunch: this.ideDetected || !!this.cfg.ideCommand,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.antigravity;
  }

  buildRun(ctx: RunContext): RunPlan {
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const commandToUse = this.cliDetected ? this.resolvedCliBin : bin;
    const args: string[] = commandToUse === bin ? [...prefixArgs] : [];

    const promptParts: string[] = [ctx.text];
    for (const att of ctx.attachments) {
      promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    }
    const prompt = promptParts.join('\n');

    args.push('-p', prompt, '--output-format', 'stream-json');

    if (ctx.resumeId) {
      args.push('--conversation', ctx.resumeId);
    }

    const model = resolveModelArg(ctx.model);
    if (model) {
      args.push('--model', model);
    }

    if (ctx.permissionMode === 'bypass') {
      args.push('--dangerously-skip-permissions');
    } else if (ctx.permissionMode === 'acceptEdits') {
      args.push('--mode', 'accept-edits');
    } else if (ctx.permissionMode === 'plan') {
      args.push('--mode', 'plan');
    }

    const effort = effortArg(ctx.thinkingEffort);
    if (effort) {
      args.push('--effort', effort);
    }

    const parser = createAntigravityStreamParser();
    return {
      command: commandToUse,
      args,
      stdinPayloads: null,
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
    };
  }

  externalSessionIdOf(line: string): string | undefined {
    const parsed = safeJson(line) as AntigravityStreamLine | undefined;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.conversation_id === 'string' && parsed.conversation_id) {
      return parsed.conversation_id;
    }
    if (typeof parsed.step_update?.conversation_id === 'string' && parsed.step_update.conversation_id) {
      return parsed.step_update.conversation_id;
    }
    if (typeof parsed.result?.conversation_id === 'string' && parsed.result.conversation_id) {
      return parsed.result.conversation_id;
    }
    return undefined;
  }

  ideCommand(projectPath: string): { command: string; args: string[] } {
    const configured = this.cfg.ideCommand ?? `flatpak run ${FLATPAK_APP}`;
    const { bin, prefixArgs } = splitCommand(configured);
    return { command: bin, args: [...prefixArgs, projectPath] };
  }
}

export function createAntigravityStreamParser() {
  let sawTextDelta = false;

  function parse(line: string, emit: (event: AgentEvent) => void): void {
    const parsed = safeJson(line) as AntigravityStreamLine | undefined;
    if (!parsed || typeof parsed !== 'object') {
      if (line.trim()) emit({ type: 'raw', line });
      return;
    }

    if (parsed.event === 'init') {
      emit({ type: 'status', status: 'running', detail: 'Antigravity session initialized' });
      return;
    }

    if (parsed.event === 'step_update' && parsed.step_update) {
      const step = parsed.step_update;
      if (step.step_type === 'user_input' || step.step_type === 'system_message') {
        return;
      }

      if (step.step_type === 'agent_response') {
        if (step.text_delta) {
          sawTextDelta = true;
          emit({ type: 'text-delta', text: step.text_delta });
        }
        if (step.thinking_delta) {
          emit({ type: 'thinking-delta', text: step.thinking_delta });
        }
        if (step.usage) {
          emit({
            type: 'usage',
            inputTokens: step.usage.input_tokens,
            outputTokens: step.usage.output_tokens,
          });
        }
        return;
      }

      if (step.step_type === 'tool') {
        const toolName = step.tool_name ?? step.tool_info?.name ?? 'tool';
        if (step.state === 'ACTIVE') {
          const params = step.tool_info?.parameters;
          const summary = params ? summarizeInput(params) : undefined;
          emit({ type: 'tool-use', tool: toolName, summary });
        } else if (step.state === 'DONE') {
          const ok = !step.error;
          const output = step.tool_info?.output;
          const summary = step.error
            ? step.error
            : output
              ? truncate(typeof output === 'string' ? output : JSON.stringify(output), 200)
              : undefined;
          emit({ type: 'tool-result', tool: toolName, ok, summary });
        }
        return;
      }
    }

    if (parsed.event === 'result' && parsed.result) {
      const res = parsed.result;
      if (res.usage) {
        emit({
          type: 'usage',
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        });
      }
      if (!sawTextDelta && res.response) {
        emit({ type: 'text-delta', text: res.response });
      }
      if (res.status === 'ERROR' || res.error) {
        emit({ type: 'status', status: 'error', detail: res.error ?? 'Antigravity run failed' });
      }
      return;
    }

    if (line.trim()) {
      emit({ type: 'raw', line });
    }
  }

  return { parse };
}
