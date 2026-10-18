import { describe, expect, it } from 'vitest';
import type { ModelPreset } from '@agentdeck/shared';
import {
  filterModels,
  groupModels,
  isDefaultModelSelection,
  pinnedModels,
  selectableModels,
} from '../src/features/chat/modelPicker';

const preset = (id: string, label: string, provider?: string): ModelPreset => ({
  id,
  label,
  ...(provider ? { provider } : {}),
});

describe('model picker helpers', () => {
  it('treats undefined and inherit as the default selection', () => {
    expect(isDefaultModelSelection(undefined)).toBe(true);
    expect(isDefaultModelSelection('inherit')).toBe(true);
    expect(isDefaultModelSelection('opencode-go/glm-5.3')).toBe(false);
  });

  it('hides synthetic default/custom rows from the catalog list', () => {
    const models = [
      preset('inherit', 'Default'),
      preset('custom', 'Custom…'),
      preset('opencode-go/glm-5.3', 'GLM 5.3', 'opencode-go'),
    ];
    expect(selectableModels(models).map((m) => m.id)).toEqual(['opencode-go/glm-5.3']);
  });

  it('filters by label, id or provider, case-insensitively', () => {
    const models = [
      preset('opencode-go/glm-5.3', 'GLM 5.3', 'opencode-go'),
      preset('openrouter/deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'openrouter'),
    ];
    expect(filterModels(models, 'glm').map((m) => m.label)).toEqual(['GLM 5.3']);
    expect(filterModels(models, 'OPENROUTER').map((m) => m.id)).toEqual([
      'openrouter/deepseek/deepseek-v4.1-flash',
    ]);
    expect(filterModels(models, 'deepseek').map((m) => m.label)).toEqual(['DeepSeek V4.1 Flash']);
    expect(filterModels(models, '   ')).toHaveLength(2);
  });

  it('groups providers and puts the default model provider first', () => {
    const models = [
      preset('opencode-go/glm-5.3', 'GLM 5.3', 'opencode-go'),
      preset('openrouter/a', 'A', 'openrouter'),
      preset('openrouter/b', 'B', 'openrouter'),
    ];
    const groups = groupModels(models, 'openrouter');
    expect(groups.map((g) => g.provider)).toEqual(['openrouter', 'opencode-go']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['openrouter/a', 'openrouter/b']);
  });

  it('keeps a flat agent list as one headerless group', () => {
    const groups = groupModels([preset('opus', 'Opus'), preset('sonnet', 'Sonnet')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe('');
    expect(groups[0]?.models).toHaveLength(2);
  });

  it('pins favorites and recents on top, dropping them from the rest', () => {
    const models = [
      preset('a/opus', 'Opus', 'a'),
      preset('a/sonnet', 'Sonnet', 'a'),
      preset('b/glm', 'GLM', 'b'),
    ];
    const pinned = pinnedModels(models, ['b/glm'], ['a/sonnet', 'b/glm']);
    expect(pinned.favorites.map((m) => m.id)).toEqual(['b/glm']);
    // A favorite is not repeated in the recents.
    expect(pinned.recents.map((m) => m.id)).toEqual(['a/sonnet']);
    expect(pinned.rest.map((m) => m.id)).toEqual(['a/opus']);
  });

  it('keeps a pinned model that left the catalog, with a synthetic row', () => {
    const pinned = pinnedModels([preset('a/opus', 'Opus', 'a')], ['a/old'], []);
    expect(pinned.favorites.map((m) => m.id)).toEqual(['a/old']);
    expect(pinned.favorites[0]?.label).toBe('a/old');
  });
});
