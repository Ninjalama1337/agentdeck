/**
 * Thinking/reasoning effort: validation of user input + mapping to the
 * per-agent CLI flags. Only low|medium|high map to actual CLI arguments;
 * 'default'/'adaptive'/blank/undefined mean "no explicit flag" (inherit).
 */
import type { ThinkingEffort } from '@agentdeck/shared';

/** All values accepted in CreateSessionRequest/SendTurnRequest. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = [
  'default',
  'adaptive',
  'low',
  'medium',
  'high',
];

/** Effort levels that map to a CLI flag for claude/codex. */
export const CLI_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type CliEffortLevel = (typeof CLI_EFFORT_LEVELS)[number];

/** AgentInfo.efforts for agents with CLI effort support ('default' always allowed). */
export const AGENT_EFFORTS: string[] = ['default', ...CLI_EFFORT_LEVELS];

export type EffortParseResult =
  | { ok: true; effort?: ThinkingEffort }
  | { ok: false; value: string };

/**
 * Validates raw request input. Blank/undefined → inherit (ok, no effort).
 * Case-insensitive match against the known levels; anything else is rejected
 * so the route can answer 400 INVALID_EFFORT.
 */
export function parseEffortInput(value: string | undefined): EffortParseResult {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, effort: undefined };
  const lower = trimmed.toLowerCase();
  if ((THINKING_EFFORTS as readonly string[]).includes(lower)) {
    return { ok: true, effort: lower as ThinkingEffort };
  }
  return { ok: false, value: trimmed };
}

/** Maps a stored effort to a CLI flag value, or undefined when no flag applies. */
export function effortArg(effort: string | undefined): CliEffortLevel | undefined {
  const lower = effort?.trim().toLowerCase();
  if (!lower) return undefined;
  return (CLI_EFFORT_LEVELS as readonly string[]).includes(lower)
    ? (lower as CliEffortLevel)
    : undefined;
}

export function validEffortsText(): string {
  return THINKING_EFFORTS.join(', ');
}
