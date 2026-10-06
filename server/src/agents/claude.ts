/**
 * Claude Code adapter — fully headless via stream-json (facts verified in
 * CONTRACT.md): `claude -p --input-format stream-json --output-format
 * stream-json --verbose --include-partial-messages`, `--model`,
 * `--permission-mode`, `--resume`. Turns from the chat add
 * `--permission-prompt-tool stdio`: Claude then asks on stdout before a tool
 * call it may not make on its own, and reads the answer from stdin.
 */
import type {
  AgentCapabilities,
  AgentEvent,
  AgentId,
  ModelPreset,
  PermissionMode,
  PermissionQuestion,
  PermissionRequest,
} from '@agentdeck/shared';
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
  type PermissionAnswer,
  type PermissionSignal,
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
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_cost_usd?: number;
  };
  /** `result` line: what each model used, keyed by its full id. */
  modelUsage?: Record<string, { outputTokens?: number }>;
  /** Set on everything a sub-agent (Task tool) produced. */
  parent_tool_use_id?: string | null;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
  };
  /** `stream_event` lines (--include-partial-messages): one raw API stream event. */
  event?: {
    type?: string;
    message?: { id?: string };
    delta?: { type?: string; text?: string; thinking?: string };
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
    // Text arrives as it is written instead of one block per finished message.
    args.push('--include-partial-messages');
    if (model) args.push('--model', model);
    args.push('--permission-mode', PERMISSION_MODE_MAP[ctx.permissionMode] ?? 'default');
    const effort = effortArg(ctx.thinkingEffort);
    if (effort) args.push('--effort', effort);
    if (ctx.resumeId) args.push('--resume', ctx.resumeId);
    // Bypass never asks, so there is nothing to answer.
    const asks = ctx.interactive === true && ctx.permissionMode !== 'bypass';
    if (asks) args.push('--permission-prompt-tool', 'stdio');

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
      ...(asks ? { permissions: claudePermissionSignal } : {}),
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
  /** Message whose blocks are arriving as partial chunks right now. */
  let streamingId: string | undefined;
  /** Messages whose text / thinking already went out as chunks — skipped when the finished block follows. */
  const streamedText = new Set<string>();
  const streamedThinking = new Set<string>();

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
      case 'stream_event': {
        // Sub-agents running in parallel interleave their chunks — their text
        // comes whole with the 'assistant' line instead.
        if (parsed.parent_tool_use_id) return;
        const ev = parsed.event;
        if (ev?.type === 'message_start') {
          streamingId = ev.message?.id;
        } else if (ev?.type === 'content_block_delta' && streamingId) {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawTextDelta = true;
            streamedText.add(streamingId);
            emit({ type: 'text-delta', text: ev.delta.text });
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            streamedThinking.add(streamingId);
            emit({ type: 'thinking-delta', text: ev.delta.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        const content = parsed.message?.content;
        if (!Array.isArray(content)) return;
        const msgId = parsed.message?.id;
        const textSent = msgId !== undefined && streamedText.has(msgId);
        const thinkingSent = msgId !== undefined && streamedThinking.has(msgId);
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            if (textSent) continue;
            sawTextDelta = true;
            emit({ type: 'text-delta', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            if (thinkingSent) continue;
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
          const model = mainModelOf(parsed.modelUsage);
          emit({
            type: 'usage',
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            ...(usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
            ...(usage?.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
            costUsd,
            ...(model ? { model } : {}),
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

/** The model that wrote most of the turn — "haiku" or no model at all becomes the id that really ran. */
function mainModelOf(modelUsage: ClaudeStreamLine['modelUsage']): string | undefined {
  let best: string | undefined;
  let most = -1;
  for (const [model, used] of Object.entries(modelUsage ?? {})) {
    const out = used?.outputTokens ?? 0;
    if (out > most) {
      most = out;
      best = model;
    }
  }
  return best;
}

const DETAIL_MAX = 6000;

interface ClaudeControlLine {
  type?: string;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: unknown;
    description?: string;
    permission_suggestions?: ClaudePermissionSuggestion[];
  };
}

interface ClaudePermissionSuggestion {
  type?: string;
  mode?: string;
  rules?: { toolName?: string; ruleContent?: string }[];
  directories?: string[];
}

/** Reads Claude's control lines (`--permission-prompt-tool stdio`) — see PermissionSignal. */
export function claudePermissionSignal(line: string): PermissionSignal | undefined {
  // Cheap pre-check: every stdout line of the run passes through here.
  if (!line.includes('"control_') && !line.includes('"result"')) return undefined;
  const parsed = safeJson(line) as ClaudeControlLine | undefined;
  if (!parsed || typeof parsed !== 'object') return undefined;
  if (parsed.type === 'result') return { kind: 'end' };
  if (parsed.type === 'control_cancel_request' && typeof parsed.request_id === 'string') {
    return { kind: 'cancel', id: parsed.request_id };
  }
  if (parsed.type !== 'control_request' || typeof parsed.request_id !== 'string') return undefined;
  const id = parsed.request_id;
  const req = parsed.request;
  if (req?.subtype !== 'can_use_tool') {
    return {
      kind: 'reply',
      line: JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: id, error: 'Not supported by AgentDeck.' },
      }),
    };
  }
  const input = req.input;
  const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
  const questions = questionsOf(req.tool_name, input);
  const always = questions ? undefined : alwaysLabel(suggestions);
  const summary = questions ? questions[0]?.question : (summarizeInput(input) ?? req.description);
  const detail = questions ? undefined : detailOf(req.tool_name, input);
  const request: PermissionRequest = {
    id,
    tool: req.tool_name ?? 'tool',
    ...(summary ? { summary } : {}),
    ...(detail ? { detail } : {}),
    ...(always ? { always } : {}),
    ...(questions ? { questions } : {}),
    ts: Date.now(),
  };
  const respond = (response: unknown): string =>
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  return {
    kind: 'ask',
    request,
    answer(answer: PermissionAnswer) {
      if (answer.decision === 'deny') {
        return { line: respond({ behavior: 'deny', message: answer.message?.trim() || 'The user denied this tool call.' }) };
      }
      const base = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const updatedInput = questions ? { ...base, answers: answer.answers ?? {} } : base;
      if (answer.decision === 'always' && always) {
        // "Accept edits" lives in the session only — the next turn starts a new
        // process, so the mode is handed back to be kept with the session.
        const mode: PermissionMode | undefined = suggestions.some((s) => s.type === 'setMode' && s.mode === 'acceptEdits')
          ? 'acceptEdits'
          : undefined;
        return {
          line: respond({ behavior: 'allow', updatedInput, updatedPermissions: suggestions }),
          ...(mode ? { permissionMode: mode } : {}),
        };
      }
      return { line: respond({ behavior: 'allow', updatedInput }) };
    },
  };
}

/** The questions of an AskUserQuestion call; undefined for every other tool. */
function questionsOf(tool: string | undefined, input: unknown): PermissionQuestion[] | undefined {
  if (tool !== 'AskUserQuestion' || !input || typeof input !== 'object') return undefined;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return undefined;
  const questions: PermissionQuestion[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || typeof q.question !== 'string') continue;
    const options = Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[])
          .filter((o) => o && typeof o.label === 'string')
          .map((o) => ({
            label: o.label as string,
            ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
          }))
      : [];
    questions.push({
      question: q.question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions.length ? questions : undefined;
}

/** What "always allow" would cover, in the words of Claude's own suggestion. */
function alwaysLabel(suggestions: ClaudePermissionSuggestion[]): string | undefined {
  const parts: string[] = [];
  for (const s of suggestions) {
    if (s.type === 'addRules') {
      for (const rule of s.rules ?? []) {
        if (rule.toolName) parts.push(rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
      }
    } else if (s.type === 'setMode' && s.mode === 'acceptEdits') {
      parts.push('all file edits');
    }
  }
  return parts.length ? truncate(parts.join(', '), 200) : undefined;
}

/** The tool call as the user should read it before deciding. */
function detailOf(tool: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? truncate(input, DETAIL_MAX) : undefined;
  const obj = input as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined);
  const prefixed = (text: string, mark: string): string =>
    text
      .split('\n')
      .map((l) => mark + l)
      .join('\n');
  let detail: string | undefined;
  if (tool === 'Bash' && str('command')) {
    detail = str('description') ? `${str('command')}\n\n# ${str('description')}` : str('command');
  } else if (tool === 'Edit' && str('file_path')) {
    detail = `${str('file_path')}\n${prefixed(str('old_string') ?? '', '- ')}\n${prefixed(str('new_string') ?? '', '+ ')}`;
  } else if (tool === 'Write' && str('file_path')) {
    detail = `${str('file_path')}\n${prefixed(str('content') ?? '', '+ ')}`;
  } else if (tool === 'ExitPlanMode' && str('plan')) {
    detail = str('plan');
  } else {
    try {
      detail = JSON.stringify(input, null, 2);
    } catch {
      detail = undefined;
    }
  }
  return detail ? truncate(detail, DETAIL_MAX) : undefined;
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
