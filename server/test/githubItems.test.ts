import { describe, expect, it } from 'vitest';
import { toGithubItem } from '../src/git/github.js';

describe('toGithubItem', () => {
  it('maps gh issue and pr JSON', () => {
    expect(
      toGithubItem('issue', { number: 7, title: 'Crash', url: 'https://x/7', author: { login: 'a' }, labels: [{ name: 'bug' }], comments: [{}, {}] }),
    ).toEqual({ kind: 'issue', number: 7, title: 'Crash', url: 'https://x/7', author: 'a', labels: ['bug'], comments: 2 });
    expect(toGithubItem('pr', { number: 8, title: 'Fix', url: 'u', labels: [], headRefName: 'fix/x', isDraft: true })).toMatchObject({
      kind: 'pr',
      headRef: 'fix/x',
      draft: true,
    });
  });
  it('drops incomplete entries', () => {
    expect(toGithubItem('issue', { title: 'no number', url: 'u' })).toBeNull();
  });
});
