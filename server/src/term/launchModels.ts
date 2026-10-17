/**
 * Models the terminal launcher offers, read from where each CLI keeps its own
 * list — so a new model shows up without an AgentDeck release: Codex's model
 * cache, OpenCode's favourites and recents, and `agy models`. Claude Code's
 * aliases are fixed (presets.ts).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchModel, TerminalPreset } from '@agentdeck/shared';
import { augmentedPath } from './presets.js';

/** Codex's `models_cache.json`: the models its picker lists, best first, with the efforts each takes. */
export function parseCodexModels(json: unknown): LaunchModel[] {
  const list = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  type Entry = {
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
    priority?: unknown;
    supported_reasoning_levels?: unknown;
  };
  return (list as Entry[])
    .filter((m) => typeof m?.slug === 'string' && m.visibility === 'list')
    .sort((a, b) => (typeof a.priority === 'number' ? a.priority : 999) - (typeof b.priority === 'number' ? b.priority : 999))
    .map((m) => {
      const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]) : [];
      const efforts = levels.map((l) => l?.effort).filter((e): e is string => typeof e === 'string');
      return {
        id: m.slug as string,
        label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        ...(efforts.length ? { efforts } : {}),
      };
    });
}

/** OpenCode's `model.json`: favourites, then recently used models, as provider/model. */
export function parseOpencodeModels(json: unknown): LaunchModel[] {
  const state = json as { favorite?: unknown; recent?: unknown } | null;
  const out: LaunchModel[] = [];
  for (const list of [state?.favorite, state?.recent]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as { providerID?: unknown; modelID?: unknown }[]) {
      if (typeof entry?.providerID !== 'string' || typeof entry.modelID !== 'string') continue;
      const id = `${entry.providerID}/${entry.modelID}`;
      if (!out.some((m) => m.id === id)) out.push({ id, label: entry.modelID, description: entry.providerID });
    }
  }
  return out;
}

/** `agy models` output: one "id<TAB>label" line per model. */
export function parseAgyModels(stdout: string): LaunchModel[] {
  const out: LaunchModel[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

/** JSON file parsed again only when it changed. */
const fileCache = new Map<string, { mtimeMs: number; models: LaunchModel[] }>();
function fromJsonFile(file: string, parse: (json: unknown) => LaunchModel[]): LaunchModel[] {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.models;
    const models = parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    fileCache.set(file, { mtimeMs, models });
    return models;
  } catch {
    return [];
  }
}

const AGY_TTL_MS = 10 * 60_000;
/** The first launcher open waits this long for `agy models` (it asks the network). */
const AGY_WAIT_MS = 3_000;
let agyCache: { at: number; models: LaunchModel[] } | undefined;
let agyPending: Promise<LaunchModel[]> | undefined;

function agyModels(bin: string, force: boolean): Promise<LaunchModel[]> {
  if (!force && agyCache && Date.now() - agyCache.at < AGY_TTL_MS) return Promise.resolve(agyCache.models);
  agyPending ??= new Promise<LaunchModel[]>((resolve) => {
    execFile(bin, ['models'], { timeout: 15_000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
      const models = err ? (agyCache?.models ?? []) : parseAgyModels(String(stdout));
      agyCache = { at: Date.now(), models };
      agyPending = undefined;
      resolve(models);
    });
  });
  const pending = agyPending;
  return Promise.race([pending, new Promise<LaunchModel[]>((resolve) => setTimeout(() => resolve(agyCache?.models ?? []), AGY_WAIT_MS).unref())]);
}

async function modelsOf(preset: TerminalPreset, force: boolean, home: string): Promise<LaunchModel[] | undefined> {
  switch (preset.id) {
    case 'codex':
      return fromJsonFile(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'models_cache.json'), parseCodexModels);
    case 'opencode': {
      const state = process.env.XDG_STATE_HOME || path.join(home, '.local/state');
      return fromJsonFile(path.join(state, 'opencode/model.json'), parseOpencodeModels);
    }
    case 'antigravity':
      return preset.resolvedPath ? agyModels(preset.resolvedPath, force) : [];
    default:
      return undefined; // fixed list (or none) in presets.ts
  }
}

/** Presets with the models each installed agent CLI offers right now. */
export async function withLaunchModels(presets: TerminalPreset[], force = false, home = os.homedir()): Promise<TerminalPreset[]> {
  return Promise.all(
    presets.map(async (preset) => {
      if (!preset.available || !preset.modelArg) return preset;
      const models = await modelsOf(preset, force, home);
      return models?.length ? { ...preset, models } : preset;
    }),
  );
}
