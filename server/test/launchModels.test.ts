import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalPreset } from '@agentdeck/shared';
import { parseAgyModels, parseCodexModels, parseOpencodeModels, withLaunchModels } from '../src/term/launchModels.js';
import { offersFlag, resolveLaunch } from '../src/term/presets.js';

describe('launch with model and effort', () => {
  it('puts the flags between the variant and the first prompt', () => {
    expect(resolveLaunch('claude', 'continue', undefined, undefined, { model: 'opus', effort: 'xhigh' }).command).toBe(
      "claude --continue --model 'opus' --effort 'xhigh'",
    );
    expect(resolveLaunch('codex', 'new', undefined, 'fix it', { model: 'gpt-6-luna', effort: 'max' }).command).toBe(
      "codex -m 'gpt-6-luna' -c model_reasoning_effort='max' 'fix it'",
    );
    expect(resolveLaunch('opencode', undefined, undefined, undefined, { model: 'opencode-go/deepseek-v4.1-flash' }).command).toBe(
      "opencode --model 'opencode-go/deepseek-v4.1-flash'",
    );
    expect(resolveLaunch('claude', undefined, undefined, undefined, { model: 'claude-opus-5-5[1m]' }).command).toBe(
      "claude --model 'claude-opus-5-5[1m]'",
    );
    // Blank = the CLI's default.
    expect(resolveLaunch('claude', undefined, undefined, undefined, { model: ' ', effort: '' }).command).toBe('claude');
  });

  it('refuses what the CLI cannot take or what is no model id', () => {
    expect(() => resolveLaunch('zcode', undefined, undefined, undefined, { model: 'GLM-5.3' })).toThrow(/cannot take a model/);
    expect(() => resolveLaunch('opencode', undefined, undefined, undefined, { effort: 'high' })).toThrow(/cannot take an effort/);
    expect(() => resolveLaunch('claude', undefined, undefined, undefined, { model: "opus'; rm -rf ~" })).toThrow(/Not a model id/);
    expect(() => resolveLaunch('claude', undefined, undefined, undefined, { effort: 'HIGH;' })).toThrow(/Not an effort/);
  });

  it('keeps a prompt with $ patterns literally', () => {
    expect(resolveLaunch('claude', undefined, undefined, "costs $& and $'")?.command).toBe("claude 'costs $& and $'\\'''");
  });
});

describe('what the installed CLI accepts', () => {
  it('recognizes a flag only as a whole token', () => {
    expect(offersFlag('FLAGS\n  --prompt string', '--model')).toBe(false);
    expect(offersFlag('FLAGS\n  -m, --model <MODEL>', '--model')).toBe(true);
    expect(offersFlag('  --model <model>   Model for the session', '--model')).toBe(true);
    expect(offersFlag('  --models          list models', '--model')).toBe(false);
    expect(offersFlag('  --model-id        set the id', '--model')).toBe(false);
  });

  it('runs the binary the launcher found, with the flags that binary takes', () => {
    const installed = (patch: Partial<TerminalPreset>): TerminalPreset => ({
      id: 'claude',
      label: 'Claude Code',
      description: 'Anthropic Claude Code TUI',
      kind: 'agent',
      command: 'claude',
      promptArg: '{prompt}',
      modelArg: '--model {value}',
      accent: '#FF6A3D',
      available: true,
      resolvedPath: '/opt/claude/bin/claude',
      variants: [{ id: 'new', label: 'New', args: '' }],
      ...patch,
    });
    // An absolute path survives a login shell that rewrites PATH.
    expect(resolveLaunch('claude', undefined, undefined, undefined, {}, installed({})).command).toBe(
      "'/opt/claude/bin/claude'",
    );
    // Version-aware: a preset without modelArg drops a remembered choice
    // instead of turning the launch into an "unrecognized flag" error.
    const opencode = installed({ id: 'opencode', command: 'opencode', label: 'OpenCode', modelArg: undefined });
    expect(resolveLaunch('opencode', undefined, undefined, undefined, {}, opencode).command).toBe(
      "'/opt/claude/bin/claude'",
    );
    expect(
      resolveLaunch('opencode', undefined, undefined, undefined, { model: 'opencode-go/deepseek-v4.1-flash' }, opencode)
        .command,
    ).toBe("'/opt/claude/bin/claude'");
  });
});

describe('model lists of the agent CLIs', () => {
  it("reads Codex's picker models, best first, with their efforts", () => {
    const models = parseCodexModels({
      models: [
        { slug: 'old', display_name: 'Old', visibility: 'list', priority: 9, supported_reasoning_levels: [{ effort: 'low' }] },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 1 },
        {
          slug: 'gpt-6-luna',
          display_name: 'GPT-6-Luna',
          description: 'Fast',
          visibility: 'list',
          priority: 4,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
        },
      ],
    });
    expect(models).toEqual([
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast', efforts: ['low', 'max'] },
      { id: 'old', label: 'Old', efforts: ['low'] },
    ]);
    expect(parseCodexModels(null)).toEqual([]);
    expect(parseCodexModels({ models: 'nope' })).toEqual([]);
  });

  it("reads OpenCode's favourites, then its recent models, once each", () => {
    expect(
      parseOpencodeModels({
        favorite: [{ providerID: 'anthropic', modelID: 'claude-opus-5-5' }],
        recent: [
          { providerID: 'opencode-go', modelID: 'qwen3.7-plus' },
          { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
          { providerID: 1 },
        ],
      }),
    ).toEqual([
      { id: 'anthropic/claude-opus-5-5', label: 'claude-opus-5-5', description: 'anthropic' },
      { id: 'opencode-go/qwen3.7-plus', label: 'qwen3.7-plus', description: 'opencode-go' },
    ]);
  });

  it('reads `agy models`', () => {
    expect(parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n')).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });
});

describe('withLaunchModels', () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home) await fsp.rm(home, { recursive: true, force: true });
    home = undefined;
  });

  const preset = (id: string, extra: Partial<TerminalPreset> = {}): TerminalPreset => ({
    id,
    label: id,
    description: '',
    kind: 'agent',
    command: id,
    accent: '#000',
    available: true,
    variants: [],
    modelArg: '--model {value}',
    ...extra,
  });

  it('fills the Codex list from its cache and leaves fixed lists alone', async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ad-models-'));
    await fsp.mkdir(path.join(home, '.codex'));
    await fsp.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: [{ slug: 'm1', visibility: 'list' }] }));
    const claude = preset('claude', { models: [{ id: 'opus', label: 'Opus' }] });
    const saved = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      const [codex, sameClaude, missing] = await withLaunchModels([preset('codex'), claude, preset('opencode', { available: false })], false, home);
      expect(codex?.models).toEqual([{ id: 'm1', label: 'm1' }]);
      expect(sameClaude).toBe(claude);
      expect(missing?.models).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CODEX_HOME = saved;
    }
  });
});
