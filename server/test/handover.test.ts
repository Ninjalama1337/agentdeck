import { describe, expect, it } from 'vitest';
import { handoverPrompt } from '../src/term/handover.js';

describe('handoverPrompt', () => {
  it('carries the task, the screen and the check-first instruction', () => {
    const p = handoverPrompt({ from: 'Claude Code', prompt: 'Add dark mode', screen: '● Editing theme.ts\n  5-hour limit reached' });
    expect(p).toMatch(/^You are taking over a task from Claude Code/);
    expect(p).toContain('The task was:\nAdd dark mode');
    expect(p).toContain('5-hour limit reached');
    expect(p).toContain('`git status`, `git diff`');
  });
  it('works without a recorded prompt', () => {
    expect(handoverPrompt({ from: 'Codex', screen: '' })).toContain('not recorded');
  });
});
