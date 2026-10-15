/**
 * Parallel worktrees (after Orca): one prompt goes to several agents, each in
 * its own git worktree on its own branch, so they cannot trample each other.
 * Afterwards the results are compared and the best one is merged into the
 * project's checkout; the rest are thrown away.
 *
 * Worktrees live in the data dir (`worktrees/<projectId>/<name>`), never inside
 * the project, next to a small JSON record (base commit, agent, prompt).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { GitDiffResponse, WorktreeInfo } from '@agentdeck/shared';
import { httpError } from '../http/errors.js';

const GIT_TIMEOUT_MS = 120_000;
const DIFF_LIMIT = 400_000;

type Record_ = Omit<WorktreeInfo, 'stats' | 'missing'>;

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await execa('git', ['-C', cwd, ...args], { reject: false, timeout: GIT_TIMEOUT_MS });
  return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? ''), exitCode: res.exitCode ?? -1 };
}

async function gitOrThrow(cwd: string, args: string[], status = 409): Promise<string> {
  const res = await git(cwd, args);
  if (res.exitCode !== 0) {
    throw httpError(status, 'GIT_ERROR', `git ${args[0]} failed: ${(res.stderr || res.stdout || 'unknown error').trim().slice(0, 500)}`);
  }
  return res.stdout;
}

/** "Fix the login bug!" → "fix-the-login-bug". */
export function slugify(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'task';
}

/** `git diff --numstat` → files and line counts (binary files count as a file only). */
export function parseNumstat(out: string): { files: number; add: number; del: number } {
  let files = 0;
  let add = 0;
  let del = 0;
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== '-') add += Number(m[1]);
    if (m[2] !== '-') del += Number(m[2]);
  }
  return { files, add, del };
}

export class WorktreeStore {
  constructor(private readonly dataDir: string) {}

  private dirOf(projectId: string): string {
    return path.join(this.dataDir, 'worktrees', projectId.replace(/[^\w.-]/g, '_'));
  }

  private recordFile(projectId: string, name: string): string {
    return path.join(this.dirOf(projectId), `${name}.json`);
  }

  private async read(projectId: string, name: string): Promise<Record_> {
    if (!/^[\w.-]+$/.test(name)) throw httpError(400, 'BAD_NAME', 'Invalid worktree name');
    try {
      return JSON.parse(await fsp.readFile(this.recordFile(projectId, name), 'utf8')) as Record_;
    } catch {
      throw httpError(404, 'NOT_FOUND', 'Worktree not found');
    }
  }

  private async write(projectId: string, rec: Record_): Promise<void> {
    await fsp.mkdir(this.dirOf(projectId), { recursive: true });
    await fsp.writeFile(this.recordFile(projectId, rec.name), JSON.stringify(rec, null, 2));
  }

  /** New worktree on a new branch from the project's HEAD. */
  async create(
    projectId: string,
    projectPath: string,
    opts: { prompt: string; presetId: string; label: string },
  ): Promise<WorktreeInfo> {
    const base = (await gitOrThrow(projectPath, ['rev-parse', 'HEAD'], 400)).trim();
    const suffix = Math.random().toString(36).slice(2, 6);
    const name = `${slugify(opts.prompt, 24)}-${opts.presetId}-${suffix}`;
    const branch = `agentdeck/${name}`;
    const dir = path.join(this.dirOf(projectId), name);
    await fsp.mkdir(this.dirOf(projectId), { recursive: true });
    await gitOrThrow(projectPath, ['worktree', 'add', '-b', branch, dir, base]);
    const rec: Record_ = { name, path: dir, branch, base, presetId: opts.presetId, label: opts.label, prompt: opts.prompt, createdAt: Date.now() };
    await this.write(projectId, rec);
    return rec;
  }

  async setTerminal(projectId: string, name: string, terminalId: string): Promise<void> {
    const rec = await this.read(projectId, name);
    await this.write(projectId, { ...rec, terminalId });
  }

  async list(projectId: string, liveTerminals: Set<string>): Promise<WorktreeInfo[]> {
    let files: string[];
    try {
      files = (await fsp.readdir(this.dirOf(projectId))).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: WorktreeInfo[] = [];
    for (const f of files) {
      const rec = await this.read(projectId, f.slice(0, -5)).catch(() => null);
      if (!rec) continue;
      const { terminalId, ...rest } = rec;
      const info: WorktreeInfo = { ...rest, ...(terminalId && liveTerminals.has(terminalId) ? { terminalId } : {}) };
      const exists = await fsp.stat(rec.path).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) info.missing = true;
      else info.stats = await this.stats(rec);
      out.push(info);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Everything the agent changed, uncommitted and untracked files included. */
  private async stageAll(rec: Record_): Promise<void> {
    // Intent-to-add makes new files show in `git diff <base>` without committing them.
    await git(rec.path, ['add', '-A', '--intent-to-add']);
  }

  private async stats(rec: Record_): Promise<WorktreeInfo['stats']> {
    await this.stageAll(rec);
    return parseNumstat((await git(rec.path, ['diff', '--numstat', rec.base])).stdout);
  }

  async diff(projectId: string, name: string): Promise<GitDiffResponse> {
    const rec = await this.read(projectId, name);
    await this.stageAll(rec);
    const out = (await git(rec.path, ['diff', '--no-color', rec.base])).stdout;
    return { diff: out.slice(0, DIFF_LIMIT), truncated: out.length > DIFF_LIMIT };
  }

  /**
   * Commits whatever the agent left in the worktree and merges its branch into
   * the project's current branch. A conflict is aborted — the checkout stays as it was.
   */
  async apply(projectId: string, projectPath: string, name: string): Promise<{ merged: string }> {
    const rec = await this.read(projectId, name);
    await git(rec.path, ['add', '-A']);
    const dirty = (await git(rec.path, ['diff', '--cached', '--quiet'])).exitCode !== 0;
    if (dirty) {
      const own = (await git(rec.path, ['config', 'user.email'])).stdout.trim() !== '';
      await gitOrThrow(rec.path, [...(own ? [] : ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost']), 'commit', '-q', '--no-verify', '-m', `${rec.label}: ${rec.prompt.split('\n')[0]!.slice(0, 72)}`]);
    }
    // The merge commit is the user's; only without any git identity does AgentDeck stand in.
    const hasIdentity = (await git(projectPath, ['config', 'user.email'])).stdout.trim() !== '';
    const identity = hasIdentity ? [] : ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost'];
    const res = await git(projectPath, [...identity, 'merge', '--no-edit', rec.branch]);
    if (res.exitCode !== 0) {
      await git(projectPath, ['merge', '--abort']);
      throw httpError(409, 'MERGE_CONFLICT', `Could not merge ${rec.branch}: ${(res.stderr || res.stdout).trim().slice(0, 400)} — the checkout is unchanged.`);
    }
    return { merged: rec.branch };
  }

  /** Removes the folder, the branch and the record. */
  async remove(projectId: string, projectPath: string, name: string): Promise<Record_> {
    const rec = await this.read(projectId, name);
    await git(projectPath, ['worktree', 'remove', '--force', rec.path]);
    await fsp.rm(rec.path, { recursive: true, force: true });
    await git(projectPath, ['worktree', 'prune']);
    await git(projectPath, ['branch', '-D', rec.branch]);
    await fsp.rm(this.recordFile(projectId, name), { force: true });
    return rec;
  }
}
