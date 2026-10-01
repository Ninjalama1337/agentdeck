/**
 * Antigravity adapter. Flatpak app `com.google.Antigravity`; headless
 * capability is unverified, so:
 * - detect = flatpak package exists (never spawns the GUI),
 * - default mode `auto` resolves to IDE mode (`flatpak run com.google.Antigravity <path>`),
 * - headless only when config forces mode:'headless' (experimental CLI probe).
 */
import type { AgentCapabilities, AgentId, ModelPreset } from '@agentdeck/shared';
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
import { createClaudeStreamParser } from './claude.js';

const FLATPAK_APP = 'com.google.Antigravity';

const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions',
};

export class AntigravityAdapter implements AgentAdapter {
  readonly id: AgentId = 'antigravity';
  readonly label = 'Antigravity';
  readonly kind = 'ide' as const;
  readonly accentColor = '#4E8CFF';
  readonly supportsResume = false;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    // If command is agy (or non-flatpak), probe version directly:
    if (bin !== 'flatpak') {
      try {
        const res = await withTimeoutFallback(execa(bin, ['--version'], { reject: false }), 4000, null, `${bin} --version`);
        if (res && res.exitCode === 0) {
          const version = /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1];
          return { available: true, version };
        }
      } catch {
        // Fall through to flatpak probe
      }
    }
    // Probe via flatpak info (does not launch the app).
    try {
      const res = await withTimeoutFallback(
        execa('flatpak', ['info', FLATPAK_APP], { reject: false }),
        5000,
        null,
        'flatpak info',
      );
      if (res && res.exitCode === 0) {
        const version = /Version:\s*(\S+)/.exec(res.stdout ?? '')?.[1];
        return { available: true, version };
      }
      return { available: false, reason: `Antigravity CLI (${bin}) or Flatpak (${FLATPAK_APP}) not found` };
    } catch {
      return { available: false, reason: `Antigravity CLI (${bin}) or Flatpak (${FLATPAK_APP}) not found` };
    }
  }

  capabilities(): AgentCapabilities {
    return {
      headless: this.cfg.mode === 'headless',
      images: false,
      resume: false,
      streaming: this.cfg.mode === 'headless',
      ideLaunch: true,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.antigravity;
  }

  buildRun(ctx: RunContext): RunPlan {
    // Experimental headless probe via the CLI wrapper inside the flatpak.
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      PERMISSION_MODE_MAP[ctx.permissionMode] ?? 'default',
    ];
    const model = resolveModelArg(ctx.model);
    if (model) args.push('--model', model);
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const promptParts: string[] = [ctx.text];
    for (const att of ctx.attachments) {
      promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    }
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: promptParts.join('\n') }] },
    });
    const parser = createClaudeStreamParser();
    return {
      command: bin,
      args: [...prefixArgs, ...args],
      stdinPayloads: [payload],
      expectStream: true,
      parse: (line, emit) => parser.parse(line, emit),
      notice: 'Antigravity headless mode is experimental (capability unverified).',
    };
  }

  ideCommand(projectPath: string): { command: string; args: string[] } {
    const configured = this.cfg.ideCommand ?? `flatpak run ${FLATPAK_APP}`;
    const { bin, prefixArgs } = splitCommand(configured);
    return { command: bin, args: [...prefixArgs, projectPath] };
  }
}
