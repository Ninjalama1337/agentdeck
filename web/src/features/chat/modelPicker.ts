import type { ModelPreset } from '@agentdeck/shared';

/** `undefined` and the legacy `inherit` both mean "use the agent default". */
export function isDefaultModelSelection(model: string | undefined): model is undefined | 'inherit' {
  return model === undefined || model === 'inherit';
}

/**
 * The model a new chat will start with. `undefined` means the agent's own
 * default. An id outside the fetched catalog (custom id) is still returned so
 * the UI can show it instead of silently falling back.
 */
export function savedDefaultModel(
  model: string | undefined,
  models: ModelPreset[],
): ModelPreset | undefined {
  if (!model || isDefaultModelSelection(model)) return undefined;
  return models.find((m) => m.id === model) ?? { id: model, label: model };
}

/** Drop the two synthetic entries; the sheet renders its own default row and free-form field. */
export function selectableModels(models: ModelPreset[]): ModelPreset[] {
  return models.filter((m) => m.id !== 'inherit' && m.id !== 'custom');
}

/** Case-insensitive match across label, id and provider. */
export function filterModels(models: ModelPreset[], query: string): ModelPreset[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((m) =>
    [m.label, m.id, m.provider, m.description]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

export interface ModelGroup {
  provider: string;
  models: ModelPreset[];
}/**
 * Groups the catalog by provider (OpenCode lists several) and puts the
 * default model's provider first. Agents with one flat list yield one group
 * with an empty provider name, which renders without a header.
 */
export function groupModels(models: ModelPreset[], defaultProvider?: string): ModelGroup[] {
  const groups = new Map<string, ModelPreset[]>();
  for (const model of models) {
    const key = model.provider ?? '';
    const list = groups.get(key);
    if (list) list.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, models: list }))
    .sort((a, b) => {
      if (defaultProvider) {
        if (a.provider === defaultProvider && b.provider !== defaultProvider) return -1;
        if (b.provider === defaultProvider && a.provider !== defaultProvider) return 1;
      }
      return a.provider.localeCompare(b.provider);
    });
}

export interface PinnedModels {
  favorites: ModelPreset[];
  recents: ModelPreset[];
  /** The remaining models, in catalog order. */
  rest: ModelPreset[];
}

/**
 * Splits the catalog into the picker's top sections: favorites first, then
 * recently used (favorites already shown are dropped), then the rest. An id
 * that is not in the catalog (a custom id, or a model the provider retired) is
 * still rendered from a synthetic preset, so a pinned entry never disappears.
 */
export function pinnedModels(models: ModelPreset[], favoriteIds: string[], recentIds: string[]): PinnedModels {
  const byId = new Map(models.map((m) => [m.id, m]));
  const preset = (id: string): ModelPreset => byId.get(id) ?? { id, label: id, description: id };
  const favoriteSet = new Set(favoriteIds);
  const favorites = favoriteIds.map(preset);
  const recents = recentIds.filter((id) => !favoriteSet.has(id)).map(preset);
  const pinned = new Set([...favoriteIds, ...recents.map((m) => m.id)]);
  return { favorites, recents, rest: models.filter((m) => !pinned.has(m.id)) };
}
