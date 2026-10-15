import type { GithubItemDetail } from '@agentdeck/shared';

/** The prompt an agent gets for an issue (work on it) or a PR (review it). */
export function githubPrompt(item: GithubItemDetail): string {
  const body = item.body.trim() || '(no description)';
  if (item.kind === 'pr') {
    return [
      `Review pull request #${item.number}${item.headRef ? ` (branch ${item.headRef})` : ''}: "${item.title}"`,
      '',
      body,
      '',
      `${item.url}`,
      `Use \`gh pr diff ${item.number}\` and \`gh pr view ${item.number} --comments\`. Point out bugs, risky changes and missing tests.`,
    ].join('\n');
  }
  return [
    `Work on GitHub issue #${item.number} of this repository: "${item.title}"`,
    '',
    body,
    '',
    `${item.url}`,
    `\`gh issue view ${item.number} --comments\` shows the discussion.`,
  ].join('\n');
}
