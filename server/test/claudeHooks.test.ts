import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  interpretClaudeHook,
  removeClaudeHookSettings,
  withClaudeHooks,
  writeClaudeHookSettings,
} from '../src/term/claudeHooks.js';
import { AttentionDetector } from '../src/term/attention.js';

describe('Claude Code terminal hooks', () => {
  it('attaches the settings file to a claude launch only', () => {
    expect(withClaudeHooks('claude', '/d/t_1.json')).toBe("claude --settings '/d/t_1.json'");
    expect(withClaudeHooks('claude --continue', "/it's/t.json")).toBe("claude --settings '/it'\\''s/t.json' --continue");
    expect(withClaudeHooks('claude-foo', '/d/t.json')).toBe('claude-foo');
    expect(withClaudeHooks('codex resume', '/d/t.json')).toBe('codex resume');
  });

  it('writes a private settings file whose hooks call the bridge route', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hooks-'));
    try {
      const file = writeClaudeHookSettings(dir, 't_abc', 4700, 'secret');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const { hooks } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        hooks: Record<string, { hooks: { type: string; url: string; headers: Record<string, string> }[] }[]>;
      };
      expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'UserPromptSubmit']);
      expect(hooks.Stop[0].hooks[0]).toMatchObject({
        type: 'http',
        url: 'http://127.0.0.1:4700/api/bridge/terminal-hook/t_abc',
        headers: { Authorization: 'Bearer secret' },
      });
      removeClaudeHookSettings(dir, 't_abc');
      expect(fs.existsSync(file)).toBe(false);
      removeClaudeHookSettings(dir, 't_abc'); // already gone: no throw
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a permission dialog with what it is about', () => {
    expect(
      interpretClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'date > out3.txt', description: 'Write the current date to out3.txt' },
      }),
    ).toEqual({ kind: 'ask', confirmed: false, detail: 'Bash: date > out3.txt' });
    expect(
      interpretClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Do you prefer tea or coffee?', options: [] }] },
      }),
    ).toEqual({ kind: 'ask', confirmed: false, detail: 'Do you prefer tea or coffee?' });
    expect(interpretClaudeHook({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } })).toEqual({
      kind: 'ask',
      confirmed: false,
      detail: 'Edit: /a/b.ts',
    });
  });

  it("takes Claude's own notification as a confirmed dialog and skips the idle reminder", () => {
    expect(
      interpretClaudeHook({ hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' }),
    ).toEqual({ kind: 'ask', confirmed: true, detail: 'Claude needs your permission' });
    expect(interpretClaudeHook({ hook_event_name: 'Notification', message: 'Claude is waiting', notification_type: 'idle_prompt' })).toBeUndefined();
  });

  it('reads the end of a turn off the last reply', () => {
    expect(interpretClaudeHook({ hook_event_name: 'Stop', last_assistant_message: 'The file contains the **date**.' })).toEqual({
      kind: 'result',
      state: 'done',
      detail: 'The file contains the date.',
    });
    expect(interpretClaudeHook({ hook_event_name: 'Stop', last_assistant_message: 'Done so far.\n\nShall I also push it?' })).toMatchObject({
      kind: 'result',
      state: 'waiting',
    });
    expect(interpretClaudeHook({ hook_event_name: 'Stop', last_assistant_message: "You've hit your usage limit · resets 9pm" })).toMatchObject({
      kind: 'result',
      state: 'limit',
    });
    expect(interpretClaudeHook({ hook_event_name: 'Stop' })).toEqual({ kind: 'result', state: 'done' });
  });

  it('tells a used-up limit from other failures', () => {
    expect(interpretClaudeHook({ hook_event_name: 'StopFailure', error: 'rate_limit' })).toEqual({
      kind: 'result',
      state: 'limit',
      detail: 'rate_limit',
    });
    expect(interpretClaudeHook({ hook_event_name: 'StopFailure', error: 'server_error', error_details: 'Overloaded' })).toEqual({
      kind: 'result',
      state: 'error',
      detail: 'Overloaded',
    });
  });

  it('ignores everything else', () => {
    expect(interpretClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).toEqual({ kind: 'working' });
    expect(interpretClaudeHook({ hook_event_name: 'PreToolUse' })).toBeUndefined();
    expect(interpretClaudeHook('nope')).toBeUndefined();
  });

  it('stops the quiet-after-work guess once hooks report', () => {
    let clock = 0;
    const hits: string[] = [];
    const d = new AttentionDetector({
      idleNotify: true,
      prompted: true,
      quietMs: 20,
      minBusyMs: 10,
      now: () => clock,
      onAttention: (r) => hits.push(r),
    });
    d.output('working');
    clock = 15;
    d.output('still working');
    d.stopIdleNotify();
    clock = 30;
    d.output('more');
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(hits).toEqual([]);
        d.output('\x07'); // a bell still counts
        expect(hits).toEqual(['bell']);
        d.dispose();
        resolve();
      }, 60),
    );
  });
});
