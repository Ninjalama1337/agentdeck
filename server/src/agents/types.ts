/**
 * Agent adapter abstraction. Each adapter knows how to detect its binary,
 * describe capabilities/models, build a run (argv + stdin payloads) and parse
 * its native stdout format into normalized `AgentEvent`s.
 */
import type {
  AgentCapabilities,
  AgentEvent,
  AgentId,
  AgentKind,
  ModelCatalog,
  ModelPreset,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  Session,
  Project,
} from '@agentdeck/shared';

/** A file attached to a turn (absolute path on this machine). */
export interface RunAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
  /** Pre-loaded base64 payload (populated for images by the manager). */
  base64?: string;
}

export interface RunContext {
  session: Session;
  project: Project;
  text: string;
  attachments: RunAttachment[];
  model?: string;
  /** Turn effort (turn override or session default). Adapters map it to CLI flags. */
  thinkingEffort?: string;
  permissionMode: PermissionMode;
  resumeId?: string;
  /** The turn comes from the chat, so the user can be asked before a tool call. */
  interactive?: boolean;
}

/** What the user answered to a PermissionRequest. */
export interface PermissionAnswer {
  decision: PermissionDecision;
  message?: string;
  answers?: Record<string, string>;
}

/** What a stdout line of a run that asks for permissions means for the manager. */
export type PermissionSignal =
  | {
      kind: 'ask';
      request: PermissionRequest;
      /** The stdin line that answers it; `permissionMode` when the answer changes the session's mode for good. */
      answer(answer: PermissionAnswer): { line: string; permissionMode?: PermissionMode };
    }
  /** The agent withdrew a question. */
  | { kind: 'cancel'; id: string }
  /** A request nobody can answer — reply at once so the agent does not wait. */
  | { kind: 'reply'; line: string }
  /** The turn is over: stdin closes and the CLI exits. */
  | { kind: 'end' };

export interface RunPlan {
  /** Executable to spawn (already resolved from the configured command). */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Lines to write to stdin (each JSONL); null → prompt passed via argv / no stdin. */
  stdinPayloads: string[] | null;
  expectStream: boolean;
  /** Optional one-line caveat shown to the user when the run starts. */
  notice?: string;
  /**
   * Set when the run asks the user before tool calls: stdin stays open for the
   * answers, and every stdout line is offered here first.
   */
  permissions?(line: string): PermissionSignal | undefined;
  /**
   * Stateful stdout parser for this specific run. Feeds one raw line at a
   * time and emits normalized events. (Per-run state — e.g. tool_use_id →
   * name maps — lives in the closure.)
   */
  parse(line: string, emit: (event: AgentEvent) => void): void;
}

export interface DetectResult {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  kind: AgentKind;
  accentColor: string;
  supportsResume: boolean;
  /** Supported thinking-effort levels ('default' always allowed); undefined when unsupported. */
  readonly efforts?: readonly string[];
  detect(): Promise<DetectResult>;
  capabilities(): AgentCapabilities;
  defaultModels(): ModelPreset[];
  /**
   * Live model catalog from the CLI itself (OpenCode knows its providers and
   * configured default). Omitted by adapters whose models are a fixed list.
   */
  listModels?(cwd?: string): Promise<ModelCatalog>;
  /** Default model of the most recently loaded catalog (for AgentInfo). */
  defaultModel?(): ModelPreset | undefined;
  buildRun(ctx: RunContext): RunPlan;
  /**
   * Extracts an external conversation id (for resume) from a raw stdout line,
   * if the line carries one.
   */
  externalSessionIdOf?(line: string): string | undefined;
  /** Returns launch parameters to open/focus a project inside the agent's IDE. */
  ideCommand?(projectPath: string): { command: string; args: string[] } | null;
}

/** Small helper: compact one-line summary of a tool input object. */
export function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'string') {
    const s = input.trim().replace(/\s+/g, ' ');
    return s.length > 0 ? (s.length > 200 ? s.slice(0, 200) + '…' : s) : undefined;
  }
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const preferred = ['file_path', 'filePath', 'path', 'command', 'CommandLine', 'commandLine', 'pattern', 'url', 'query', 'description', 'prompt'];
  const parts: string[] = [];
  for (const key of preferred) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim().replace(/\s+/g, ' '));
    }
    if (parts.length >= 2) break;
  }
  let summary = parts.join(' · ');
  if (!summary) {
    try {
      summary = JSON.stringify(input);
    } catch {
      summary = '[unserializable input]';
    }
  }
  if (summary.length > 200) summary = summary.slice(0, 200) + '…';
  return summary || undefined;
}

/** 'inherit' / 'custom' / empty mean "no explicit model flag". */
export function resolveModelArg(model?: string): string | undefined {
  if (!model) return undefined;
  const m = model.trim();
  if (!m || m === 'inherit' || m === 'custom') return undefined;
  return m;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}
