import { describe, expect, it } from 'vitest';
import { githubPrompt } from '../src/features/git/githubPrompt';

const base = { number: 12, title: 'Login fails', url: 'https://github.com/o/r/issues/12', labels: [], thread: [] };

describe('githubPrompt', () => {
  it('asks to work on an issue, with its text and how to read the discussion', () => {
    const p = githubPrompt({ ...base, kind: 'issue', body: 'Steps: …' });
    expect(p).toMatch(/^Work on GitHub issue #12 of this repository: "Login fails"/);
    expect(p).toContain('Steps: …');
    expect(p).toContain('gh issue view 12 --comments');
  });
  it('asks to review a PR with its branch and diff command', () => {
    const p = githubPrompt({ ...base, kind: 'pr', headRef: 'fix/login', body: '' });
    expect(p).toMatch(/^Review pull request #12 \(branch fix\/login\)/);
    expect(p).toContain('(no description)');
    expect(p).toContain('gh pr diff 12');
  });
});
