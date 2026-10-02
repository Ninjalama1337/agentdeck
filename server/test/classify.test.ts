import { describe, expect, it } from 'vitest';
import { classifyReply, classifyScreen, isLimitError } from '../src/notify/classify.js';
import { stateTitle } from '../src/notify/hub.js';

const screen = (...lines: string[]) => lines.join('\n');

describe('classifyScreen', () => {
  it('reads a finished turn as done', () => {
    const s = screen(
      '● I updated the three files and the tests pass.',
      '',
      '╭──────────────────────────────────────────╮',
      '│ >                                        │',
      '╰──────────────────────────────────────────╯',
      '  ? for shortcuts',
    );
    expect(classifyScreen(s)).toEqual({ state: 'done' });
  });

  it('reads a Claude Code permission prompt as waiting and quotes the question', () => {
    const s = screen(
      '╭──────────────────────────────────────────╮',
      '│ Bash command                             │',
      '│   npm run build                          │',
      '│ Do you want to proceed?                  │',
      '│ ❯ 1. Yes                                 │',
      "│   2. Yes, and don't ask again            │",
      '│   3. No, and tell Claude what to do      │',
      '╰──────────────────────────────────────────╯',
    );
    expect(classifyScreen(s)).toEqual({ state: 'waiting', detail: 'Do you want to proceed?' });
  });

  it('recognizes a choice menu without a known question', () => {
    const s = screen('Which database should I use?', '❯ 1. Postgres', '  2. SQLite', 'Enter to select · Esc to cancel');
    expect(classifyScreen(s)).toEqual({ state: 'waiting', detail: 'Which database should I use?' });
  });

  it('recognizes shell-style confirmations', () => {
    expect(classifyScreen('Overwrite existing file? [y/N]').state).toBe('waiting');
    expect(classifyScreen('Press Enter to continue').state).toBe('waiting');
  });

  it('reads used-up usage as limit, whatever the agent', () => {
    for (const line of [
      'Claude usage limit reached. Your limit will reset at 3pm (Europe/Berlin).',
      '5-hour limit reached ∙ resets 9pm',
      'Weekly limit reached ∙ resets Oct 6, 9am',
      "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 12 minutes.",
      'You exceeded your current quota, please check your plan and billing details.',
      'Quota exceeded for quota metric',
      'Credit balance is too low',
    ]) {
      expect(classifyScreen(screen('● Working on it…', line, ' > ')), line).toEqual({ state: 'limit', detail: line });
    }
  });

  it('prefers the limit over the menu it comes with', () => {
    const s = screen('5-hour limit reached ∙ resets 9pm', 'What do you want to do?', '❯ 1. Stop and wait for limit to reset', 'Enter to confirm · Esc to cancel');
    expect(classifyScreen(s).state).toBe('limit');
  });

  it('ignores history that scrolled far up', () => {
    const old = ['Do you want to proceed?', '❯ 1. Yes'];
    const later = Array.from({ length: 16 }, (_, i) => `● step ${i} finished`);
    expect(classifyScreen(screen(...old, ...later)).state).toBe('done');
  });

  it("uses the program's own notification text", () => {
    expect(classifyScreen('', 'Claude needs your permission to use Bash')).toEqual({
      state: 'waiting',
      detail: 'Claude needs your permission to use Bash',
    });
    expect(classifyScreen('', 'Codex: Turn complete')).toEqual({ state: 'done', detail: 'Codex: Turn complete' });
  });
});

describe('classifyReply', () => {
  it('tells a result from a closing question and a limit message', () => {
    expect(classifyReply('Done. All tests pass.').state).toBe('done');
    expect(classifyReply('I found two options.\n\nShould I go with the migration?').state).toBe('waiting');
    expect(classifyReply('Claude AI usage limit reached|1759410000')).toMatchObject({ state: 'limit' });
    expect(classifyReply(undefined).state).toBe('done');
  });

  it('does not take a long answer about rate limits for one', () => {
    const answer = ['The API returns 429 when the rate limit is exceeded.', 'I added a retry.', 'Backoff is exponential.', 'Tests cover it.'].join('\n');
    expect(classifyReply(answer).state).toBe('done');
  });
});

describe('notification titles', () => {
  it('lead with the state', () => {
    expect(stateTitle('done', 'Claude Code', 'agentdeck')).toBe('✅ Claude Code is done · agentdeck');
    expect(stateTitle('waiting', 'Codex', 'agentdeck')).toBe('✋ Codex needs your input · agentdeck');
    expect(stateTitle('limit', 'Claude Code', 'agentdeck')).toBe('⛔ Claude Code hit its usage limit · agentdeck');
    expect(isLimitError('Error: You have exhausted your daily quota on this model.')).toBe(true);
    expect(isLimitError('ENOENT: no such file')).toBe(false);
  });
});
