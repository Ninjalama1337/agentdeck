import { describe, expect, it } from 'vitest';
import { mapOpenCodeCatalog, mapOpenCodeModelLines } from '../src/agents/opencode.js';

/**
 * The OpenCode picker must show the same provider/model references the CLI
 * accepts, plus the model a run would use without `--model`.
 */
describe('OpenCode model catalog', () => {
  it('maps the API rows to provider/model presets and keeps the default', () => {
    const catalog = mapOpenCodeCatalog(
      [
        { id: 'deepseek/deepseek-v4.1-flash', providerID: 'openrouter', name: 'DeepSeek V4.1 Flash' },
        { id: 'glm-5.3', providerID: 'opencode-go', name: 'GLM 5.3' },
      ],
      { id: 'deepseek/deepseek-v4.1-flash', providerID: 'openrouter', name: 'DeepSeek V4.1 Flash' },
    );

    expect(catalog.models.map((m) => m.id)).toEqual([
      'opencode-go/glm-5.3',
      'openrouter/deepseek/deepseek-v4.1-flash',
    ]);
    expect(catalog.models[1]).toMatchObject({
      label: 'DeepSeek V4.1 Flash',
      provider: 'openrouter',
    });
    expect(catalog.defaultModel?.id).toBe('openrouter/deepseek/deepseek-v4.1-flash');
  });

  it('drops duplicates and tolerates malformed rows', () => {
    const catalog = mapOpenCodeCatalog([
      { id: 'glm-5.3', providerID: 'opencode-go', name: 'GLM 5.3' },
      { id: 'glm-5.3', providerID: 'opencode-go', name: 'GLM 5.3 duplicate' },
      { id: 42, providerID: 'opencode-go' },
      { id: 'no-provider' },
      null,
    ]);

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.id).toBe('opencode-go/glm-5.3');
    expect(catalog.defaultModel).toBeUndefined();
  });

  it('falls back to the plain `opencode models` lines', () => {
    const catalog = mapOpenCodeModelLines(
      'opencode-go/glm-5.3\nopenrouter/~anthropic/claude-sonnet-latest\n\nopencode-go/glm-5.3\n',
      { id: 'glm-5.3', providerID: 'opencode-go', name: 'GLM 5.3' },
    );

    expect(catalog.models.map((m) => m.id)).toEqual([
      'opencode-go/glm-5.3',
      'openrouter/~anthropic/claude-sonnet-latest',
    ]);
    expect(catalog.models[0]?.provider).toBe('opencode-go');
    expect(catalog.defaultModel?.id).toBe('opencode-go/glm-5.3');
  });

  it('returns an empty catalog for garbage input', () => {
    expect(mapOpenCodeCatalog('nope')).toEqual({ models: [] });
    expect(mapOpenCodeModelLines('')).toEqual({ models: [] });
  });
});
