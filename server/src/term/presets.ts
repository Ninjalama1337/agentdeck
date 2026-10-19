/**
 * Terminal launcher presets ("Code" tab): one tap starts an agent TUI such as
 * Claude Code, Codex or OpenCode inside a real PTY — the phone equivalent of
 * opening a terminal and typing `claude`.
 *
 * Presets are data only. Availability is probed by scanning PATH plus the
 * usual per-user install dirs (npm-global, ~/.local/bin, ~/.opencode/bin, …),
 * because a server started from systemd rarely inherits the login shell PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TerminalPreset, TerminalPresetVariant } from '@agentdeck/shared';

type PresetDef = Omit<TerminalPreset, 'available' | 'resolvedPath'> & { bin?: string };

const NEW: TerminalPresetVariant = { id: 'new', label: 'New', args: '', hint: 'Fresh conversation' };

export const PRESET_DEFS: PresetDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic Claude Code TUI',
    kind: 'agent',
    command: 'claude',
    promptArg: '{prompt}',
    modelArg: '--model {value}',
    models: [
      { id: 'fable', label: 'Fable', description: 'Latest Fable' },
      { id: 'opus', label: 'Opus', description: 'Latest Opus' },
      { id: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet' },
      { id: 'haiku', label: 'Haiku', description: 'Latest Haiku' },
    ],
    effortArg: '--effort {value}',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    accent: '#FF6A3D',
    variants: [
      NEW,
      { id: 'continue', label: 'Continue', args: '--continue', hint: 'Resume the last conversation' },
      { id: 'resume', label: 'Pick…', args: '--resume', hint: 'Choose a past conversation' },
      {
        id: 'yolo',
        label: 'YOLO',
        args: '--dangerously-skip-permissions',
        hint: 'No permission prompts',
        danger: true,
      },
    ],
    snippets: [
      { label: '/compact', text: '/compact' },
      { label: '/clear', text: '/clear' },
      { label: '/model', text: '/model' },
      { label: '/cost', text: '/cost' },
      { label: '/review', text: '/review' },
    ],
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI',
    kind: 'agent',
    command: 'codex',
    promptArg: '{prompt}',
    // Models (and the efforts each takes) come from Codex's model cache — launchModels.ts.
    modelArg: '-m {value}',
    effortArg: '-c model_reasoning_effort={value}',
    efforts: ['low', 'medium', 'high'],
    accent: '#10B981',
    variants: [
      NEW,
      { id: 'continue', label: 'Continue', args: 'resume --last', hint: 'Resume the last session' },
      { id: 'resume', label: 'Pick…', args: 'resume', hint: 'Choose a past session' },
      { id: 'auto', label: 'Full auto', args: '--full-auto', hint: 'Workspace-write, no prompts', danger: true },
    ],
    snippets: [
      { label: '/model', text: '/model' },
      { label: '/approvals', text: '/approvals' },
      { label: '/compact', text: '/compact' },
      { label: '/diff', text: '/diff' },
      { label: '/status', text: '/status' },
    ],
    install: 'npm i -g @openai/codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'sst/opencode terminal agent',
    kind: 'agent',
    command: 'opencode',
    promptArg: '--prompt {prompt}',
    // Favourite and recent models from OpenCode's state — launchModels.ts.
    modelArg: '--model {value}',
    accent: '#F5A524',
    variants: [
      NEW,
      { id: 'continue', label: 'Continue', args: '--continue', hint: 'Resume the last session' },
      { id: 'auto', label: 'Auto', args: '--auto', hint: 'Auto-approve permissions (dangerous)', danger: true },
    ],
    snippets: [
      { label: '/models', text: '/models' },
      { label: '/sessions', text: '/sessions' },
      { label: '/compact', text: '/compact' },
      { label: '/undo', text: '/undo' },
      { label: '/share', text: '/share' },
    ],
    install: 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'Google Gemini CLI (Antigravity models)',
    kind: 'agent',
    command: 'gemini',
    promptArg: '-i {prompt}',
    accent: '#4E8CFF',
    variants: [
      NEW,
      { id: 'yolo', label: 'YOLO', args: '--yolo', hint: 'Auto-approve all actions', danger: true },
    ],
    snippets: [
      { label: '/chat', text: '/chat' },
      { label: '/compress', text: '/compress' },
      { label: '/stats', text: '/stats' },
    ],
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    description: 'Google Antigravity agent CLI (agy)',
    kind: 'agent',
    command: 'agy',
    bin: 'agy',
    // Models from `agy models` — launchModels.ts.
    modelArg: '--model {value}',
    effortArg: '--effort {value}',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    accent: '#4E8CFF',
    variants: [
      NEW,
      { id: 'continue', label: 'Continue', args: '-c', hint: 'Continue most recent session' },
      { id: 'yolo', label: 'YOLO', args: '--dangerously-skip-permissions', hint: 'Auto-approve all tool permission requests', danger: true },
      { id: 'plan', label: 'Plan', args: '--mode plan', hint: 'Plan-only mode' },
    ],
    snippets: [
      { label: '/help', text: '/help' },
      { label: '/status', text: '/status' },
      { label: '/clear', text: '/clear' },
      { label: '/exit', text: '/exit' },
    ],
  },
  {
    id: 'zcode',
    label: 'ZCode',
    description: 'Z.AI ZCode CLI TUI',
    kind: 'agent',
    command: 'zcode',
    accent: '#7C5CFF',
    variants: [
      NEW,
      { id: 'continue', label: 'Continue', args: '-c', hint: 'Resume the last session' },
      { id: 'yolo', label: 'YOLO', args: '--mode yolo', hint: 'No permission prompts', danger: true },
      { id: 'plan', label: 'Plan', args: '--mode plan', hint: 'Plan-only mode' },
    ],
    snippets: [
      { label: '/model', text: '/model' },
      { label: '/mode', text: '/mode' },
      { label: '/compact', text: '/compact' },
      { label: '/new', text: '/new' },
      { label: '/goal', text: '/goal' },
    ],
    install: 'scripts/update-zcode.sh',
  },
  {
    id: 'aider',
    label: 'Aider',
    description: 'AI pair programming in your terminal',
    kind: 'agent',
    command: 'aider',
    accent: '#14B8A6',
    variants: [NEW],
    install: 'python -m pip install aider-install && aider-install',
  },
  {
    id: 'lazygit',
    label: 'lazygit',
    description: 'Git TUI — stage, commit, rebase',
    kind: 'tool',
    command: 'lazygit',
    accent: '#F43F5E',
    variants: [NEW],
  },
  {
    id: 'btop',
    label: 'btop',
    description: 'System monitor',
    kind: 'tool',
    command: 'btop',
    accent: '#A78BFA',
    variants: [NEW],
  },
];

/** Directories searched in addition to $PATH. */
export function extraBinDirs(home = os.homedir()): string[] {
  const dirs = [
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.opencode/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.local/share/pnpm'),
    path.join(home, '.local/share/fnm/aliases/default/bin'),
    path.join(home, '.local/share/mise/shims'),
    path.join(home, '.asdf/shims'),
    path.join(home, '.yarn/bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  // nvm: every installed node version's bin (newest first).
  const nvm = path.join(home, '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(nvm).sort().reverse();
    for (const v of versions) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    // no nvm
  }
  // The base system dirs: a service manager may start us with a PATH that lacks them.
  dirs.push('/usr/bin', '/bin', '/snap/bin');
  return dirs;
}

/** PATH value with the extra dirs appended (deduplicated, existing only). */
export function augmentedPath(base = process.env.PATH ?? ''): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...base.split(':'), ...extraBinDirs()]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(':');
}

/** Absolute path of an executable, or undefined. */
export function findExecutable(name: string, pathValue = augmentedPath()): string | undefined {
  if (name.includes('/')) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const SHELL_PRESET: TerminalPreset = {
  id: 'shell',
  label: 'Shell',
  description: 'Plain login shell in the project',
  kind: 'shell',
  command: '',
  accent: '#99A1B3',
  available: true,
  variants: [NEW],
};

/**
 * Does a CLI's help text offer `flag`? A flag is offered when it appears as a
 * whole token (`--model` matches `--model <model>` and `-m, --model`, but not
 * `--models` or `--model-id`).
 */
export function offersFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,|(])${escaped}(?=$|[\\s,|=])`, 'm').test(help);
}

/** The first flag in a template such as `--model {value}` or `-c model=x={value}`. */
function flagOf(template: string): string {
  return /(?:^|\s)(--?[A-Za-z0-9][\w-]*)/.exec(template)?.[1] ?? template.split(/\s+/)[0] ?? template;
}

/** Help output that actually lists options (not a usage error or a version banner). */
function looksLikeHelp(text: string): boolean {
  return /(^|\n)\s*(usage|USAGE|Usage)\b/.test(text) || /(^|\n)\s*(FLAGS|Flags|OPTIONS|Options|COMMANDS|Commands)\b/.test(text);
}

interface FlagSupport {
  /** `false`: the installed CLI rejected the flag we would pass; `undefined`: unknown, keep it. */
  model?: boolean;
  effort?: boolean;
}

const helpCache = new Map<string, { stamp: string; support: FlagSupport }>();

/**
 * Which of a preset's optional flags the installed CLI advertises. Version
 * upgrades remove flags without warning (OpenCode v2 dropped `--model` from
 * the full-screen TUI), and a launcher must not offer what the binary refuses.
 * Unknown help output keeps the preset's flag, so unusual CLIs still work.
 */
function flagSupport(bin: string, def: PresetDef): FlagSupport {
  let stamp = bin;
  try {
    const st = fs.statSync(bin);
    stamp = `${bin}:${st.mtimeMs}:${st.size}`;
  } catch {
    // keep the path as stamp; the help probe will fail anyway
  }
  const cached = helpCache.get(bin);
  if (cached?.stamp === stamp) return cached.support;

  let help: string | undefined;
  try {
    help = execFileSync(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Some CLIs print help on stderr and exit non-zero.
    const e = err as { stdout?: unknown; stderr?: unknown };
    const out = `${typeof e.stdout === 'string' ? e.stdout : ''}\n${typeof e.stderr === 'string' ? e.stderr : ''}`.trim();
    help = out || undefined;
  }
  const support: FlagSupport =
    help && looksLikeHelp(help)
      ? {
          ...(def.modelArg ? { model: offersFlag(help, flagOf(def.modelArg)) } : {}),
          ...(def.effortArg ? { effort: offersFlag(help, flagOf(def.effortArg)) } : {}),
        }
      : {};
  helpCache.set(bin, { stamp, support });
  return support;
}

let cache: { at: number; presets: TerminalPreset[] } | undefined;
const CACHE_MS = 30_000;

/** Presets with availability resolved (cached for 30 s). */
export function listPresets(force = false): TerminalPreset[] {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.presets;
  const pathValue = augmentedPath();
  const presets: TerminalPreset[] = [SHELL_PRESET];
  for (const def of PRESET_DEFS) {
    const { bin, ...rest } = def;
    const binName = bin ?? def.command.split(/\s+/)[0] ?? def.command;
    const resolved = findExecutable(binName, pathValue);
    let available = resolved !== undefined;
    if (!available && def.id === 'antigravity') {
      const agyAlt = findExecutable('antigravity', pathValue);
      if (agyAlt) {
        available = true;
      }
    }
    const effective = { ...rest };
    if (resolved) {
      // Hide a model/effort picker the installed binary cannot honour — a
      // remembered choice would otherwise turn every launch into a CLI error.
      const support = flagSupport(resolved, def);
      if (support.model === false) delete effective.modelArg;
      if (support.effort === false) delete effective.effortArg;
    }
    presets.push({ ...effective, available, ...(resolved && available ? { resolvedPath: resolved } : {}) });
  }
  cache = { at: Date.now(), presets };
  return presets;
}

/** The launcher preset as currently installed (retries once when it looked missing). */
export function presetForLaunch(presetId: string | undefined): TerminalPreset | undefined {
  if (!presetId) return undefined;
  let preset = listPresets().find((p) => p.id === presetId);
  if (preset && !preset.available) {
    // Installed seconds ago but the availability cache still says no.
    preset = listPresets(true).find((p) => p.id === presetId) ?? preset;
  }
  return preset;
}

/** Single-quoted for a POSIX shell. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** `template` with `{key}` replaced by `value`, shell-quoted (taken literally — no `$&` patterns). */
function fillArg(template: string, key: string, value: string): string {
  return template.replace(`{${key}}`, () => shellQuote(value));
}

/** Model ids (aliases, provider/model, [1m] suffixes) and effort levels a launch accepts. */
const MODEL_ID = /^[A-Za-z0-9._:/@+[\]-]{1,120}$/;
const EFFORT = /^[a-z]{2,16}$/;

/** Model and effort to start an agent with; omitted = the CLI's default. */
export interface LaunchChoice {
  model?: string;
  effort?: string;
}

/**
 * Resolves what to type into the fresh shell. Returns undefined for a plain
 * shell. Throws on unknown preset/variant ids. `installed` is the matching
 * entry from `listPresets()`: its resolved binary path is what gets executed,
 * so a login shell that rewrites PATH cannot lose the agent that the server
 * just found (and its flag support reflects the installed CLI version).
 */
export function resolveLaunch(
  presetId: string | undefined,
  variantId: string | undefined,
  command: string | undefined,
  /** First prompt for the agent (presets with `promptArg` only). */
  prompt?: string,
  choice: LaunchChoice = {},
  installed?: TerminalPreset,
): { command?: string; title: string; presetId: string; variantId?: string; agent: boolean } {
  const custom = command?.trim();
  if (custom) {
    return { command: custom, title: custom.split(/\s+/)[0] ?? 'command', presetId: presetId ?? 'custom', agent: false };
  }
  if (!presetId || presetId === 'shell') return { title: 'shell', presetId: 'shell', agent: false };
  const def = PRESET_DEFS.find((p) => p.id === presetId);
  if (!def) throw new Error(`Unknown terminal preset: ${presetId}`);
  const preset = installed?.id === def.id ? installed : undefined;
  const variant = def.variants.find((v) => v.id === (variantId ?? 'new'));
  if (!variant) throw new Error(`Unknown variant ${variantId} for ${presetId}`);
  const first = prompt?.trim();
  if (first && !def.promptArg) throw new Error(`${def.label} cannot take a prompt on start`);
  const promptArgs = first && def.promptArg ? fillArg(def.promptArg, 'prompt', first) : '';
  const modelArg = preset ? preset.modelArg : def.modelArg;
  const effortArg = preset ? preset.effortArg : def.effortArg;
  const requestedModel = choice.model?.trim();
  const requestedEffort = choice.effort?.trim();
  // A stale client can still send a choice the installed CLI no longer takes.
  // With the resolved preset we know that, and dropping it beats a launch that
  // dies on an unrecognized flag; a direct API call for a preset without the
  // flag is still an error.
  if (requestedModel && !modelArg && !preset) throw new Error(`${def.label} cannot take a model on start`);
  if (requestedEffort && !effortArg && !preset) throw new Error(`${def.label} cannot take an effort on start`);
  const model = requestedModel && modelArg ? requestedModel : undefined;
  if (model && !MODEL_ID.test(model)) throw new Error(`Not a model id: ${model}`);
  const effort = requestedEffort && effortArg ? requestedEffort : undefined;
  if (effort && !EFFORT.test(effort)) throw new Error(`Not an effort level: ${effort}`);
  const modelArgs = model && modelArg ? fillArg(modelArg, 'value', model) : '';
  const effortArgs = effort && effortArg ? fillArg(effortArg, 'value', effort) : '';
  const primary = preset?.resolvedPath ? shellQuote(preset.resolvedPath) : def.command;
  const cmd = [primary, variant.args, modelArgs, effortArgs, promptArgs].filter((s) => s.trim()).join(' ');
  const title = variant.id === 'new' ? def.label : `${def.label} · ${variant.label}`;
  return { command: cmd, title, presetId: def.id, variantId: variant.id, agent: def.kind === 'agent' };
}
