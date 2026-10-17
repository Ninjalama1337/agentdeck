import { describe, expect, it } from 'vitest';
import type { TerminalPreset } from '@agentdeck/shared';
import { effortName, effortsFor, validChoice } from '../src/features/code/launchChoice';

describe('launch choice', () => {
  const claude: TerminalPreset = {
    id: 'claude',
    label: 'Claude Code',
    description: '',
    kind: 'agent',
    command: 'claude',
    accent: '#000',
    available: true,
    variants: [],
    modelArg: '--model {value}',
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'tiny', label: 'Tiny', efforts: ['low'] },
    ],
    effortArg: '--effort {value}',
    efforts: ['low', 'high', 'xhigh'],
  };

  it("takes a model's own effort list over the agent's", () => {
    expect(effortsFor(claude, 'opus')).toEqual(['low', 'high', 'xhigh']);
    expect(effortsFor(claude, 'tiny')).toEqual(['low']);
    expect(effortsFor({ ...claude, effortArg: undefined }, 'opus')).toEqual([]);
  });

  it('drops what the agent no longer offers', () => {
    expect(validChoice(claude, { model: 'opus', effort: 'xhigh' })).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(validChoice(claude, { model: 'gone', effort: 'high' })).toEqual({ effort: 'high' });
    expect(validChoice(claude, { model: 'tiny', effort: 'high' })).toEqual({ model: 'tiny' });
  });

  it('names effort levels', () => {
    expect(effortName('xhigh')).toBe('X-High');
    expect(effortName('max')).toBe('Max');
  });
});
