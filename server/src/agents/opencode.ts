import type {
  AgentCapabilities,
  AgentEvent,
  AgentId,
  ModelCatalog,
  ModelPreset,
} from '@agentdeck/shared';
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
    output?: unknown;
    content?: unknown;
    metadata?: { content?: unknown };
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

/** How long a discovered catalog stays fresh. Models change rarely. */
const CATALOG_TTL_MS = 60_000;
const CATALOG_TIMEOUT_MS = 4000;

interface OpenCodeModelInfo {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
}

interface CachedCatalog {
  at: number;
  catalog: ModelCatalog;
}

/**
 * Turns the response of OpenCode's `/api/model` (+ `/api/model/default`) into
 * the picker shape. The full model reference is `provider/model` (the same
 * string `opencode models` prints and `opencode run -m` accepts).
 */
export function mapOpenCodeCatalog(
  list: unknown,
  defaultInfo?: unknown,
  fallbackDefault?: unknown,
): ModelCatalog {
  const rows = Array.isArray(list) ? list : [];
  const seen = new Set<string>();
  const models: ModelPreset[] = [];
  for (const row of rows) {
    const preset = presetOf(row);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    models.push(preset);
  }
  models.sort(
    (a, b) =>
      (a.provider ?? '').localeCompare(b.provider ?? '') || a.label.localeCompare(b.label),
  );

  const defaultModel = presetOf(defaultInfo) ?? presetOf(fallbackDefault);
  if (defaultModel && !seen.has(defaultModel.id)) models.unshift(defaultModel);
  return { models, ...(defaultModel ? { defaultModel } : {}) };
}

/** Parses the `opencode models` fallback (one `provider/model` per line). */
export function mapOpenCodeModelLines(stdout: string, defaultInfo?: unknown): ModelCatalog {
  const models: ModelPreset[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: id,
      description: id,
      provider: id.split('/')[0],
    });
  }
  models.sort(
    (a, b) =>
      (a.provider ?? '').localeCompare(b.provider ?? '') || a.label.localeCompare(b.label),
  );
  const defaultModel = presetOf(defaultInfo);
  return { models, ...(defaultModel ? { defaultModel } : {}) };
}

function presetOf(value: unknown): ModelPreset | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const model = value as OpenCodeModelInfo;
  if (typeof model.id !== 'string' || !model.id) return undefined;
  if (typeof model.providerID !== 'string' || !model.providerID) return undefined;
  return {
    id: `${model.providerID}/${model.id}`,
    label: typeof model.name === 'string' && model.name ? model.name : model.id,
    description: model.id,
    provider: model.providerID,
  };
}

/** `opencode api` wraps responses in `{ location, data }`; tolerate bare JSON too. */
function jsonData(stdout: string | undefined): unknown {
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout) as { data?: unknown };
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  } catch {
    return undefined;
  }
}

/** Pulls the text out of OpenCode's `output` / `content` shapes. */
function toolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((item) =>
      item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : undefined,
    )
    .filter((part): part is string => part !== undefined)
    .join('\n');
  return text || undefined;
}

/**
 * A short preview of what a tool returned. Shell output can be huge, so it is
 * capped; the chat shows it under the command that produced it.
 */
export function summarizeToolOutput(state: {
  output?: unknown;
  content?: unknown;
  metadata?: { content?: unknown };
  error?: unknown;
}): string | undefined {
  const raw =
    toolOutputText(state.output) ??
    toolOutputText(state.content) ??
    toolOutputText(state.metadata?.content) ??
    toolOutputText(state.error);
  const text = raw?.trim();
  if (!text) return undefined;
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
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
          // `state.title` is usually just the tool name ("shell"); the input is
          // what actually says what the call did, so it always wins.
          const inputSummary = summarizeInput(state.input);
          const summary = inputSummary ?? state.title;
          if (callID && !usedTools.has(callID)) {
            usedTools.add(callID);
            emit({ type: 'tool-use', tool, ...(summary ? { summary } : {}) });
          }
          if ((state.status === 'completed' || state.status === 'error') && callID && !doneTools.has(callID)) {
            doneTools.add(callID);
            const result = summarizeToolOutput(state);
            emit({
              type: 'tool-result',
              tool,
              ok: state.status !== 'error',
              // Only a summary from the input; a bare title must not overwrite
              // the command/path the tool-use event already reported.
              ...(inputSummary ? { summary: inputSummary } : {}),
              ...(result ? { result } : {}),
            });
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
  private readonly catalogs = new Map<string, CachedCatalog>();

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

  defaultModel(): ModelPreset | undefined {
    let newest: CachedCatalog | undefined;
    for (const entry of this.catalogs.values()) {
      if (!newest || entry.at > newest.at) newest = entry;
    }
    return newest?.catalog.defaultModel;
  }

  /**
   * OpenCode knows its catalog and the model it would actually use (including
   * auto-selection from the configured providers). Both come from its local
   * API, so the app can show the real list instead of a static guess.
   */
  async listModels(cwd?: string): Promise<ModelCatalog> {
    const key = cwd ?? process.cwd();
    const cached = this.catalogs.get(key);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;

    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const apiGet = (endpoint: string) =>
      withTimeoutFallback(
        execa(bin, [...prefixArgs, 'api', 'get', endpoint], {
          cwd: key,
          reject: false,
          timeout: CATALOG_TIMEOUT_MS,
        }),
        CATALOG_TIMEOUT_MS,
        null,
        `opencode api get ${endpoint}`,
      );

    const [listRes, defaultRes] = await Promise.all([
      apiGet('/api/model'),
      apiGet('/api/model/default'),
    ]);

    const list = jsonData(listRes?.exitCode === 0 ? listRes.stdout : undefined);
    const defaultInfo = jsonData(defaultRes?.exitCode === 0 ? defaultRes.stdout : undefined);
    let catalog: ModelCatalog;
    if (Array.isArray(list)) {
      catalog = mapOpenCodeCatalog(list, defaultInfo);
    } else {
      // Older OpenCode builds without the API: fall back to `opencode models`.
      const res = await withTimeoutFallback(
        execa(bin, [...prefixArgs, 'models'], { cwd: key, reject: false, timeout: CATALOG_TIMEOUT_MS }),
        CATALOG_TIMEOUT_MS,
        null,
        'opencode models',
      );
      catalog =
        res && res.exitCode === 0
          ? mapOpenCodeModelLines(res.stdout, defaultInfo)
          : { models: MODEL_PRESETS.opencode };
    }

    this.catalogs.set(key, { at: Date.now(), catalog });
    // Keep the map bounded when the app is used across many projects.
    if (this.catalogs.size > 8) {
      const oldest = [...this.catalogs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.catalogs.delete(oldest[0]);
    }
    return catalog;
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
