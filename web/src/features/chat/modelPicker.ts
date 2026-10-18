import type { ModelPreset } from '@agentdeck/shared';

/** `undefined` and the legacy `inherit` both mean "use the agent default". */
export function isDefaultModelSelection(model: string | undefined): boolean {
  return model === undefined || model === 'inherit';
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
}

/**
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
