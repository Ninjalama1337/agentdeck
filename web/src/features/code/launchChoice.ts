/**
 * Model and effort picked per agent in the terminal launcher — remembered on
 * this device, so every later start of that agent (launcher, Home, shortcut,
 * "send to a new terminal") uses them too.
 */
import type { TerminalPreset } from '@agentdeck/shared';

export interface LaunchChoice {
  model?: string;
  effort?: string;
}

const KEY = 'agentdeck:launch-choice';

function stored(): Record<string, LaunchChoice> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LaunchChoice>) : {};
  } catch {
    return {};
  }
}

/** Effort levels the preset takes with `model` (a model may bring its own list). */
export function effortsFor(preset: TerminalPreset, model: string | undefined): string[] {
  if (!preset.effortArg) return [];
  return preset.models?.find((m) => m.id === model)?.efforts ?? preset.efforts ?? [];
}

/** `choice` without what the preset does not offer (any more). */
export function validChoice(preset: TerminalPreset, choice: LaunchChoice): LaunchChoice {
  const model = choice.model && preset.modelArg && preset.models?.some((m) => m.id === choice.model) ? choice.model : undefined;
  const effort = choice.effort && effortsFor(preset, model).includes(choice.effort) ? choice.effort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function launchChoice(preset: TerminalPreset): LaunchChoice {
  return validChoice(preset, stored()[preset.id] ?? {});
}

export function rememberLaunchChoice(presetId: string, choice: LaunchChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...stored(), [presetId]: choice }));
  } catch {
    /* storage unavailable */
  }
}

/** Display name of an effort level ("xhigh" → "X-High"). */
export function effortName(level: string): string {
  if (level === 'xhigh') return 'X-High';
  return level.charAt(0).toUpperCase() + level.slice(1);
}
