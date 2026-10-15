/**
 * Limit hand-over: an agent ran out of usage mid-task, another one (or the
 * same agent on another account) picks it up in the same folder. The prompt
 * carries the task and the end of the old terminal's screen, and tells the
 * new agent to look at what is already done before it continues.
 */
export function handoverPrompt(ctx: { from: string; prompt?: string; screen: string }): string {
  const parts = [
    `You are taking over a task from ${ctx.from}, which stopped because its usage limit ran out.`,
    '',
    ctx.prompt ? `The task was:\n${ctx.prompt.trim()}` : 'The original task is not recorded — work it out from the terminal output below.',
  ];
  if (ctx.screen.trim()) {
    parts.push('', `The end of ${ctx.from}'s terminal:`, '```', ctx.screen.trim().slice(-6000), '```');
  }
  parts.push(
    '',
    'Part of the work may already be done. Check the state first (`git status`, `git diff`), then continue where it stopped — do not start over.',
  );
  return parts.join('\n');
}
