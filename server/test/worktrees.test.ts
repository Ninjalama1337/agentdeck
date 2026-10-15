import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseNumstat, slugify, WorktreeStore } from '../src/git/worktrees.js';
import { resolveLaunch, shellQuote } from '../src/term/presets.js';

const ID = ['-c', 'user.name=T', '-c', 'user.email=t@t'];
function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, ...ID, 'commit', '-q', '-m', 'init']);
  return root;
}

describe('helpers', () => {
  it('slugifies prompts and parses numstat', () => {
    expect(slugify('Fix the login bug!')).toBe('fix-the-login-bug');
    expect(slugify('???')).toBe('task');
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n')).toEqual({ files: 2, add: 3, del: 1 });
  });

  it('passes the first prompt on the command line, shell-quoted', () => {
    expect(resolveLaunch('claude', undefined, undefined, "don't panic").command).toBe(`claude ${shellQuote("don't panic")}`);
    expect(resolveLaunch('opencode', undefined, undefined, 'hi').command).toBe("opencode --prompt 'hi'");
    expect(() => resolveLaunch('zcode', undefined, undefined, 'hi')).toThrow(/cannot take a prompt/);
  });
});

describe('WorktreeStore', () => {
  it('creates, measures, merges and removes a worktree', async () => {
    const project = repo();
    const store = new WorktreeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-wt-data-')));
    const wt = await store.create('p1', project, { prompt: 'Add b', presetId: 'claude', label: 'Claude Code' });
    expect(wt.branch).toMatch(/^agentdeck\/add-b-claude-/);

    // The agent edits a file and adds one, without committing.
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n');
    const [listed] = await store.list('p1', new Set());
    expect(listed!.stats).toEqual({ files: 2, add: 2, del: 0 });
    expect((await store.diff('p1', wt.name)).diff).toContain('+new');

    await store.apply('p1', project, wt.name);
    expect(fs.readFileSync(path.join(project, 'b.txt'), 'utf8')).toBe('new\n');

    await store.remove('p1', project, wt.name);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await store.list('p1', new Set())).toEqual([]);
    expect(execFileSync('git', ['-C', project, 'branch', '--list', 'agentdeck/*']).toString().trim()).toBe('');
  });

  it('aborts a conflicting merge and leaves the checkout alone', async () => {
    const project = repo();
    const store = new WorktreeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-wt-data-')));
    const wt = await store.create('p1', project, { prompt: 'x', presetId: 'codex', label: 'Codex' });
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'theirs\n');
    fs.writeFileSync(path.join(project, 'a.txt'), 'ours\n');
    execFileSync('git', ['-C', project, ...ID, 'commit', '-qam', 'ours']);
    await expect(store.apply('p1', project, wt.name)).rejects.toThrow(/Could not merge/);
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('ours\n');
    expect(execFileSync('git', ['-C', project, 'status', '--porcelain']).toString()).toBe('');
  });
});
