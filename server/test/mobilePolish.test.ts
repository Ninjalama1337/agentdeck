import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttentionDetector, isTyped } from '../src/term/attention.js';
import { listPresets, resolveLaunch } from '../src/term/presets.js';
import { assertRelPath, gitBranches, gitChanges, gitDiff, gitLog, parsePorcelainZ } from '../src/git/gitOps.js';
import { cleanTranscript } from '../src/voice/transcribe.js';
import { summarize } from '../src/notify/hub.js';

describe('AttentionDetector', () => {
  afterEach(() => vi.useRealTimers());

  it('fires on a bare bell but not on OSC title sequences', () => {
    const hits: string[] = [];
    const d = new AttentionDetector({ idleNotify: false, onAttention: (r) => hits.push(r) });
    d.output('\x1b]0;my title\x07prompt $ ');
    expect(hits).toEqual([]);
    d.output('done\x07');
    expect(hits).toEqual(['bell']);
  });

  it('does not mistake a title split across chunks for a bell', () => {
    const hits: string[] = [];
    const d = new AttentionDetector({ idleNotify: false, onAttention: (r) => hits.push(r) });
    d.output('abc\x1b]0;half');
    d.output(' title\x07more');
    expect(hits).toEqual([]);
  });

  it('parses OSC 9 and OSC 777 notifications, ignores OSC 9;4 progress', () => {
    const hits: [string, string | undefined][] = [];
    const d = new AttentionDetector({ idleNotify: false, throttleMs: 0, onAttention: (r, t) => hits.push([r, t]) });
    d.output('\x1b]9;4;1;50\x07');
    expect(hits).toEqual([]);
    d.output('\x1b]9;Claude needs your permission\x07');
    d.output('\x1b]777;notify;Codex;Turn complete\x1b\\');
    expect(hits).toEqual([
      ['notify', 'Claude needs your permission'],
      ['notify', 'Codex: Turn complete'],
    ]);
  });

  it('reports quiet-after-work for agent terminals, reset by input', () => {
    vi.useFakeTimers();
    let now = 0;
    const hits: string[] = [];
    const d = new AttentionDetector({
      idleNotify: true,
      quietMs: 1000,
      minBusyMs: 3000,
      now: () => now,
      onAttention: (r) => hits.push(r),
    });
    // nobody gave it work yet (startup screen) → nothing to finish
    for (let i = 0; i < 8; i++) {
      now += 500;
      d.output('.');
    }
    now += 1000;
    vi.advanceTimersByTime(1000);
    expect(hits).toEqual([]);
    // focus reports, mouse and query replies are not the user typing
    expect(isTyped('\x1b[I\x1b[O\x1b[<64;10;5M\x1b[12;1R\x1b[?62;c\x1b]11;rgb:0000/0000/0000\x07')).toBe(false);
    expect(isTyped('\x1b[Ihi')).toBe(true);
    expect(isTyped('\r')).toBe(true);
    d.input(true);
    // short burst → not interesting
    d.output('x');
    now += 500;
    d.output('y');
    now += 1000;
    vi.advanceTimersByTime(1000);
    expect(hits).toEqual([]);
    // long busy streak then silence → idle
    for (let i = 0; i < 8; i++) {
      now += 500;
      d.output('.');
    }
    vi.advanceTimersByTime(1000);
    expect(hits).toEqual(['idle']);
    // input clears the pending streak
    for (let i = 0; i < 8; i++) {
      now += 500;
      d.output('.');
    }
    d.input();
    vi.advanceTimersByTime(5000);
    expect(hits).toEqual(['idle']);
    d.dispose();
  });
});

describe('terminal presets', () => {
  it('resolves preset + variant into a command', () => {
    expect(resolveLaunch('claude', 'continue', undefined)).toEqual({
      command: 'claude --continue',
      title: 'Claude Code · Continue',
      presetId: 'claude',
      variantId: 'continue',
      agent: true,
    });
    expect(resolveLaunch('codex', undefined, undefined).command).toBe('codex');
    expect(resolveLaunch('opencode', 'auto', undefined)).toEqual({
      command: 'opencode --auto',
      title: 'OpenCode · Auto',
      presetId: 'opencode',
      variantId: 'auto',
      agent: true,
    });
    expect(resolveLaunch('zcode', 'continue', undefined)).toEqual({
      command: 'zcode -c',
      title: 'ZCode · Continue',
      presetId: 'zcode',
      variantId: 'continue',
      agent: true,
    });
    expect(resolveLaunch('zcode', 'yolo', undefined)).toEqual({
      command: 'zcode --mode yolo',
      title: 'ZCode · YOLO',
      presetId: 'zcode',
      variantId: 'yolo',
      agent: true,
    });
    expect(resolveLaunch(undefined, undefined, undefined)).toEqual({ title: 'shell', presetId: 'shell', agent: false });
    expect(resolveLaunch(undefined, undefined, '  npm run dev ')).toMatchObject({ command: 'npm run dev', title: 'npm' });
    expect(() => resolveLaunch('nope', undefined, undefined)).toThrow();
    expect(() => resolveLaunch('claude', 'nope', undefined)).toThrow();
  });

  it('lists the shell plus agent presets', () => {
    const presets = listPresets(true);
    expect(presets[0]?.id).toBe('shell');
    expect(presets[0]?.available).toBe(true);
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode', 'gemini', 'zcode']));
  });
});

describe('git helpers', () => {
  it('parses porcelain -z output incl. renames and untracked files', () => {
    const out = ' M src/a.ts\0M  b.ts\0R  new.ts\0old.ts\0?? notes.md\0UU c.ts\0';
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'src/a.ts', state: 'modified', staged: false, unstaged: true },
      { path: 'b.ts', state: 'modified', staged: true, unstaged: false },
      { path: 'new.ts', from: 'old.ts', state: 'renamed', staged: true, unstaged: false },
      { path: 'notes.md', state: 'untracked', staged: false, unstaged: true },
      { path: 'c.ts', state: 'conflict', staged: false, unstaged: true },
    ]);
  });

  it('rejects unsafe paths', () => {
    expect(() => assertRelPath('../etc/passwd')).toThrow();
    expect(() => assertRelPath('/etc/passwd')).toThrow();
    expect(() => assertRelPath('--output=x')).toThrow();
    expect(() => assertRelPath('src/ok.ts')).not.toThrow();
  });

  it('reads changes, diffs, log and branches of a real repo', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-git-'));
    try {
      const g = (...args: string[]) => execa('git', ['-C', dir, ...args]);
      await g('init', '-b', 'main');
      await g('config', 'user.email', 't@example.com');
      await g('config', 'user.name', 'T');
      await fsp.writeFile(path.join(dir, 'a.txt'), 'one\n');
      await g('add', '.');
      await g('commit', '-m', 'first');
      await fsp.writeFile(path.join(dir, 'a.txt'), 'two\n');
      await fsp.writeFile(path.join(dir, 'new.txt'), 'hello\n');

      const changes = await gitChanges(dir);
      expect(changes.map((c) => [c.path, c.state])).toEqual([
        ['a.txt', 'modified'],
        ['new.txt', 'untracked'],
      ]);
      expect((await gitDiff(dir, 'a.txt')).diff).toContain('+two');
      expect((await gitDiff(dir, 'new.txt')).diff).toContain('+hello');
      const log = await gitLog(dir, 5);
      expect(log[0]?.subject).toBe('first');
      const branches = await gitBranches(dir);
      expect(branches.current).toBe('main');
      expect(branches.local).toEqual(['main']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('text helpers', () => {
  it('cleans whisper.cpp output', () => {
    expect(cleanTranscript('[00:00.000 --> 00:02.000]  Hallo Welt\n\n[00:02.000 --> 00:03.000] wie gehts\n')).toBe(
      'Hallo Welt wie gehts',
    );
  });

  it('summarizes markdown replies for notifications', () => {
    expect(summarize('## Done\n\nI fixed **the bug**.\n```ts\nconst a = 1;\n```')).toBe('Done I fixed the bug. [code]');
    expect(summarize('x'.repeat(300)).length).toBe(140);
  });
});
