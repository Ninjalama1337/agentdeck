/**
 * ZCode adapter.
 *
 * Since zcode-cli 0.16.x (github.com/zai-org/ZCode) there is a real headless
 * CLI — verified flags (apps/zcode-cli/packages/cli/src/arguments.ts):
 *   `-p <prompt>` · `--output-format text|json|stream-json` ·
 *   `--mode build|edit|plan|yolo` · `--resume <id>` · `--cwd <dir>` · `--verbose`
 * stdout in stream-json mode is one JSON `SessionEvent` per line:
 *   `{id, sessionId, turnId?, type, timestamp, sequenceNumber, payload}` with
 *   snake_case types (session_created, model_streaming, assistant_message,
 *   tool_call_started, tool_call_result, turn_complete, turn_error, …).
 *
 * Detection: a real CLI answers `--version` with a bare semver and no Electron
 * logs; the desktop AppImage instead logs `[main] … electron initialized` —
 * in that case (or when no binary exists) the adapter stays in IDE mode.
 * Model selection is NOT CLI-driven (no --model flag) → single "inherit"
 * preset; thinking effort is not exposed either.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { effortArg } from './effort.js';

/** Our permission modes → zcode `--mode` values. */
const MODE_MAP: Record<string, string> = {
  default: 'build',
  acceptEdits: 'edit',
  plan: 'plan',
  bypass: 'yolo',
};

const DESKTOP_MARKERS = /electron initialized|deep-link|crash-capture/i;
const SEMVER = /^\s*v?\d+\.\d+\.\d+/m;

export class ZCodeAdapter implements AgentAdapter {
  readonly id: AgentId = 'zcode';
  readonly label = 'ZCode';
  readonly kind = 'cli' as const;
  readonly accentColor = '#7C5CFF';
  readonly supportsResume = true;
  /** GLM reasoning levels are written as `options.reasoningLevel` in the
   *  provider config (the CLI has no --effort flag). */
  readonly efforts = ['default', 'low', 'medium', 'high'] as const;

  /** Set by detect(): a headless-capable zcode CLI was found. */
  private cliDetected = false;

  /** Non-fatal note when the provider-config write failed (shown as notice). */
  private lastConfigError?: string;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    let whichOk = false;
    try {
      const which = await withTimeoutFallback(
        execa('which', [bin], { reject: false }),
        5000,
        null,
        'which zcode',
      );
      whichOk = !!which && which.exitCode === 0;
    } catch {
      whichOk = false;
    }
    if (!whichOk) {
      this.cliDetected = false;
      return { available: false, reason: 'zcode not found on PATH' };
    }

    // Distinguish the headless CLI from the Electron desktop launcher.
    try {
      const res = await withTimeoutFallback(
        execa(bin, ['--version'], { reject: false, stdin: 'ignore' }),
        10_000,
        null,
        'zcode --version',
      );
      const out = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`;
      const version = (res?.stdout ?? '').match(/\d+\.\d+\.\d+/)?.[0];
      this.cliDetected =
        !!res &&
        res.exitCode === 0 &&
        !!version &&
        SEMVER.test(res.stdout ?? '') &&
        !DESKTOP_MARKERS.test(out);
      if (this.cliDetected) {
        return { available: true, version };
      }
      // Desktop launcher (Electron) — usable as IDE, not headless.
      return { available: true, version: version ?? undefined };
    } catch {
      // Probe failed (e.g. launcher hung) — assume desktop install.
      this.cliDetected = false;
      return { available: true, reason: 'headless probe failed — IDE mode' };
    }
  }

  capabilities(): AgentCapabilities {
    const headless = this.cliDetected || this.cfg.mode === 'headless';
    return {
      headless,
      images: false,
      resume: headless,
      streaming: headless,
      ideLaunch: true,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.zcode;
  }

  buildRun(ctx: RunContext): RunPlan {
    this.lastConfigError = undefined;
    // Model + thinking effort are applied via the shared provider config
    // (defaultModelSelection) — the CLI reads it at startup. Server-wide
    // default; keep the provider binding, swap model/level.
    const modelId = resolveModelArg(ctx.model);
    const level = effortArg(ctx.thinkingEffort);
    if (modelId || level) {
      try {
        applyZcodeModelSelection({ ...(modelId ? { modelId } : {}), ...(level ? { reasoningLevel: level } : {}) });
      } catch (err) {
        this.lastConfigError = err instanceof Error ? err.message : String(err);
      }
    }
    const promptParts: string[] = [ctx.text];
    for (const att of ctx.attachments) {
      promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    }
    const args = [
      '-p',
      promptParts.join('\n'),
      '--output-format',
      'stream-json',
      '--verbose',
      '--mode',
      MODE_MAP[ctx.permissionMode] ?? 'build',
    ];
    if (ctx.resumeId) args.push('--resume', ctx.resumeId);
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const parser = createZcodeStreamParser();
    return {
      command: bin,
      args: [...prefixArgs, ...args],
      // The standalone agent requires explicit provider-config paths.
      env: zcodeProviderEnv(),
      stdinPayloads: null,
      expectStream: true,
      ...(this.lastConfigError
        ? { notice: `Could not apply model/effort to the ZCode config (${this.lastConfigError}) — running with the current default.` }
        : {}),
      parse: (line, emit) => parser.parse(line, emit),
    };
  }

  externalSessionIdOf(line: string): string | undefined {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // All events of a run share the envelope sessionId; capture it from
      // creation/resume events explicitly, else from any event (first wins).
      const sid =
        (parsed.payload as Record<string, unknown> | undefined)?.sessionId ?? parsed.sessionId;
      if (typeof sid === 'string' && sid.startsWith('sess_')) return sid;
    } catch {
      /* not json */
    }
    return undefined;
  }

  ideCommand(projectPath: string): { command: string; args: string[] } | null {
    const configured = this.cfg.ideCommand ?? this.cfg.command;
    const { bin, prefixArgs } = splitCommand(configured);
    return { command: bin, args: [...prefixArgs, projectPath] };
  }
}

/** Provider-config env for the standalone agent (builtin + personal paths). */
export function zcodeProviderEnv(): Record<string, string> {
  const home = os.homedir();
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(home, '.zcode/runtime/agent/provider/zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, '.zcode/v2/provider_config.json'),
  };
}

/** Path of the personal provider config (also used by tests via injection). */
export function zcodeProviderConfigPath(): string {
  return path.join(os.homedir(), '.zcode/v2/provider_config.json');
}

export interface ZcodeModelSelectionPatch {
  modelId?: string;
  reasoningLevel?: string;
}

/**
 * Applies model + reasoning level to the shared `defaultModelSelection` in
 * the personal provider config. The CLI exposes no --model/--effort flags —
 * it reads this file at startup. Preserves an existing provider binding.
 * Atomic (temp file + rename). Throws on unreadable/unwritable config.
 */
export function applyZcodeModelSelection(
  patch: ZcodeModelSelectionPatch,
  filePath = zcodeProviderConfigPath(),
): void {
  const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const prev = (current.defaultModelSelection ?? {}) as Record<string, unknown>;
  const providerId =
    typeof prev.providerId === 'string' && prev.providerId
      ? prev.providerId
      : 'account:zai-individual-coding-plan';
  const modelId = patch.modelId ?? (typeof prev.modelId === 'string' ? prev.modelId : 'GLM-5.3');
  const prevOptions = (prev.options ?? {}) as Record<string, unknown>;
  const options = { ...prevOptions };
  if (patch.reasoningLevel) options.reasoningLevel = patch.reasoningLevel;
  else delete options.reasoningLevel;
  current.defaultModelSelection = {
    providerId,
    modelId,
    ...(Object.keys(options).length ? { options } : {}),
  };
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.agentdeck-prov-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

const LOGIN_HINT =
  'ZCode has no model configured yet — run `zcode login zai` once on this machine (opens the browser), then retry.';

// ---------------------------------------------------------------------------
// stream-json parser (SessionEvent lines, defensive payload extraction)
// ---------------------------------------------------------------------------

interface ZcodeEvent {
  type?: string;
  payload?: unknown;
}

function safeJson(line: string): ZcodeEvent | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? (v as ZcodeEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** Reasoning deltas sometimes nest under a `reasoning` key without text/delta
 *  markers — pull the first string out of that subtree only. */
function extractReasoningDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const subtree = obj.reasoning ?? obj.delta ?? obj.text ?? value;
  if (typeof subtree === 'string') return subtree.length ? subtree : undefined;
  if (typeof subtree === 'object') {
    for (const v of Object.values(subtree as Record<string, unknown>)) {
      const found = extractReasoningDeep(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Recursively find a text/delta/content STRING — never falls back to ids. */
function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['text', 'delta', 'content']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length) return v;
  }
  for (const v of Object.values(obj)) {
    const found = extractText(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function extractToolName(payload: unknown): string {
  const obj = payload as Record<string, unknown> | undefined;
  const name = obj?.toolName ?? obj?.name ?? obj?.tool;
  return typeof name === 'string' && name ? name : 'tool';
}

function extractUsage(payload: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
} {
  const usage: { inputTokens?: number; outputTokens?: number; model?: string } = {};
  const obj = payload as Record<string, unknown> | undefined;
  const src = (obj?.usage ?? obj?.summary ?? payload) as Record<string, unknown> | undefined;
  if (src && typeof src === 'object') {
    const inp = src.inputTokens ?? src.input_tokens ?? src.tokensIn;
    const out = src.outputTokens ?? src.output_tokens ?? src.tokensOut;
    if (typeof inp === 'number') usage.inputTokens = inp;
    if (typeof out === 'number') usage.outputTokens = out;
  }
  if (obj && typeof obj.model === 'string') usage.model = obj.model;
  return usage;
}

export function createZcodeStreamParser() {
  let sawTextDelta = false;

  function parse(line: string, emit: (event: AgentEvent) => void): void {
    if (!line.trim()) return;
    const parsed = safeJson(line);
    if (!parsed) {
      emit({ type: 'raw', line });
      return;
    }
    // Wire format uses dot-notation ("turn.failed"), the contracts enum
    // snake_case ("turn_failed") — normalize both.
    const type = String(parsed.type ?? '').replace(/\./g, '_');
    const payload = parsed.payload;

    switch (type) {
      case 'session_created':
      case 'session_resumed':
        emit({ type: 'status', status: 'running', detail: 'ZCode session initialized' });
        return;
      case 'model_streaming': {
        // ModelStreamingPayload { delta, done, kind?: 'text_delta'|'reasoning_delta'|… }
        // — reasoning MUST stay out of the answer text (kind discriminates).
        const obj = payload as Record<string, unknown> | undefined;
        const kind = typeof obj?.kind === 'string' ? obj.kind : '';
        const delta = typeof obj?.delta === 'string' ? obj.delta : '';
        if (kind === 'reasoning_delta') {
          if (delta) emit({ type: 'thinking-delta', text: delta });
          return;
        }
        if (kind === 'text_delta' || kind === '' || kind === 'start' || kind === 'finish') {
          if (kind === 'text_delta' && delta) {
            sawTextDelta = true;
            emit({ type: 'text-delta', text: delta });
          }
          return;
        }
        // text_start/text_end/reasoning_start/reasoning_end/tool_input_*/tool_call/error:
        // structure only — tool cards arrive via their own events.
        return;
      }
      case 'reasoning_start':
      case 'reasoning_end':
        // Structure only — the deltas carry the content.
        return;
      case 'reasoning_delta': {
        const text = extractText(payload) ?? extractReasoningDeep(payload);
        if (text) emit({ type: 'thinking-delta', text });
        return;
      }
      case 'assistant_message': {
        // Full message — only surface when streaming deltas never came.
        if (sawTextDelta) return;
        const text = extractText(payload);
        if (text) emit({ type: 'text-delta', text });
        return;
      }
      case 'tool_call_started':
      case 'tool_call_scheduled': {
        emit({ type: 'tool-use', tool: extractToolName(payload), summary: summarizeInput((payload as Record<string, unknown> | undefined)?.input) });
        return;
      }
      case 'tool_call_result':
      case 'tool_call_error': {
        const obj = payload as Record<string, unknown> | undefined;
        const ok = parsed.type === 'tool_call_result' && !obj?.error;
        emit({
          type: 'tool-result',
          tool: extractToolName(payload),
          ok,
          summary: summarizeInput(obj?.result ?? obj?.error ?? obj?.summary),
        });
        return;
      }
      case 'turn_complete': {
        const usage = extractUsage(payload);
        emit({ type: 'usage', ...usage });
        return;
      }
      case 'turn_error':
      case 'turn.failed':
      case 'model_error': {
        const raw = extractText((payload as Record<string, unknown> | undefined)?.error) ??
          extractText(payload) ??
          'ZCode reported an error';
        const message = /select a model/i.test(raw) ? LOGIN_HINT : raw;
        emit({ type: 'status', status: 'error', detail: message.slice(0, 300) });
        emit({ type: 'raw', line });
        return;
      }
      default:
        // Interesting-but-unmapped events stay visible in the raw stream.
        emit({ type: 'raw', line });
        return;
    }
  }

  return { parse };
}
