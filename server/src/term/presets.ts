/**
 * Terminal launcher presets ("Code" tab): one tap starts an agent TUI such as
 * Claude Code, Codex or OpenCode inside a real PTY — the phone equivalent of
 * opening a terminal and typing `claude`.
 *
 * Presets are data only. Availability is probed by scanning PATH plus the
 * usual per-user install dirs (npm-global, ~/.local/bin, ~/.opencode/bin, …),
 * because a server started from systemd rarely inherits the login shell PATH.
 */
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
    presets.push({ ...rest, available, ...(resolved && available ? { resolvedPath: resolved } : {}) });
  }
  cache = { at: Date.now(), presets };
  return presets;
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
 * shell. Throws on unknown preset/variant ids.
 */
export function resolveLaunch(
  presetId: string | undefined,
  variantId: string | undefined,
  command: string | undefined,
  /** First prompt for the agent (presets with `promptArg` only). */
  prompt?: string,
  choice: LaunchChoice = {},
): { command?: string; title: string; presetId: string; variantId?: string; agent: boolean } {
  const custom = command?.trim();
  if (custom) {
    return { command: custom, title: custom.split(/\s+/)[0] ?? 'command', presetId: presetId ?? 'custom', agent: false };
  }
  if (!presetId || presetId === 'shell') return { title: 'shell', presetId: 'shell', agent: false };
  const def = PRESET_DEFS.find((p) => p.id === presetId);
  if (!def) throw new Error(`Unknown terminal preset: ${presetId}`);
  const variant = def.variants.find((v) => v.id === (variantId ?? 'new'));
  if (!variant) throw new Error(`Unknown variant ${variantId} for ${presetId}`);
  const first = prompt?.trim();
  if (first && !def.promptArg) throw new Error(`${def.label} cannot take a prompt on start`);
  const promptArgs = first && def.promptArg ? fillArg(def.promptArg, 'prompt', first) : '';
  const model = choice.model?.trim();
  if (model && !def.modelArg) throw new Error(`${def.label} cannot take a model on start`);
  if (model && !MODEL_ID.test(model)) throw new Error(`Not a model id: ${model}`);
  const effort = choice.effort?.trim();
  if (effort && !def.effortArg) throw new Error(`${def.label} cannot take an effort on start`);
  if (effort && !EFFORT.test(effort)) throw new Error(`Not an effort level: ${effort}`);
  const modelArgs = model && def.modelArg ? fillArg(def.modelArg, 'value', model) : '';
  const effortArgs = effort && def.effortArg ? fillArg(def.effortArg, 'value', effort) : '';
  const cmd = [def.command, variant.args, modelArgs, effortArgs, promptArgs].filter((s) => s.trim()).join(' ');
  const title = variant.id === 'new' ? def.label : `${def.label} · ${variant.label}`;
  return { command: cmd, title, presetId: def.id, variantId: variant.id, agent: def.kind === 'agent' };
}
