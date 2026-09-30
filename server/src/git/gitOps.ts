/**
 * Git operations executed inside project directories (via execa `git -C`).
 */
import { execa } from 'execa';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  GitBranches,
  GitChange,
  GitCommitInfo,
  GitDiffResponse,
  GitFileState,
  GitOpResult,
  ProjectGitInfo,
} from '@agentdeck/shared';
import { httpError } from '../http/errors.js';
import { ensureDir } from '../util/paths.js';
import { newId } from '../util/ids.js';

const GIT_TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await execa('git', ['-C', cwd, ...args], {
    reject: false,
    timeout: GIT_TIMEOUT_MS,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.exitCode ?? -1 };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const res = await git(cwd, args);
  if (res.exitCode !== 0) {
    throw httpError(
      409,
      'GIT_ERROR',
      `git ${args[0]} failed: ${(res.stderr || res.stdout || 'unknown error').trim().slice(0, 500)}`,
    );
  }
  return res.stdout;
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const res = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return res.exitCode === 0 && res.stdout.trim() === 'true';
}

export async function gitInit(projectPath: string): Promise<void> {
  await gitOrThrow(projectPath, ['init']);
}

/** Collects branch/remote/dirty/ahead/behind; undefined when not a repo. */
export async function gitStatus(projectPath: string): Promise<ProjectGitInfo | undefined> {
  if (!(await isGitRepo(projectPath))) return undefined;
  const info: ProjectGitInfo = {};
  const [branchRes, remoteRes, sbRes] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectPath, ['config', '--get', 'remote.origin.url']),
    git(projectPath, ['status', '-sb', '--porcelain']),
  ]);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : undefined;
  if (branch) info.branch = branch;
  const remote = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : undefined;
  if (remote) info.remote = remote;
  const lines = sbRes.stdout.split('\n').filter((l) => l.trim().length > 0);
  // First line is the `## branch...origin` header (when there is a branch).
  const header = lines[0]?.startsWith('##') ? (lines[0] ?? '') : '';
  info.dirty = Math.max(0, lines.filter((l) => !l.startsWith('##')).length);
  const ahead = /ahead (\d+)/.exec(header);
  const behind = /behind (\d+)/.exec(header);
  if (ahead) info.ahead = Number(ahead[1]);
  if (behind) info.behind = Number(behind[1]);
  return info;
}

export async function gitCommit(
  projectPath: string,
  message: string,
  all = true,
  files?: string[],
): Promise<ProjectGitInfo> {
  if (files && files.length > 0) {
    for (const f of files) assertRelPath(f);
    // `add -A -- <paths>` stages modifications, additions AND deletions.
    await gitOrThrow(projectPath, ['add', '-A', '--', ...files]);
    await gitOrThrow(projectPath, ['commit', '-m', message, '--', ...files]);
  } else {
    if (all) await gitOrThrow(projectPath, ['add', '-A']);
    await gitOrThrow(projectPath, ['commit', '-m', message]);
  }
  const status = await gitStatus(projectPath);
  return status ?? {};
}

export async function gitPush(projectPath: string): Promise<{ ok: boolean; message: string }> {
  const res = await git(projectPath, ['push']);
  const message = (res.stderr || res.stdout || '').trim();
  if (res.exitCode !== 0) {
    return { ok: false, message: message.slice(0, 500) || 'git push failed' };
  }
  return { ok: true, message: message || 'Pushed' };
}

// ---------------------------------------------------------------------------
// Changes, diff, log, branches
// ---------------------------------------------------------------------------

/** Rejects absolute paths, `..` traversal and option-looking paths. */
export function assertRelPath(p: string): void {
  if (!p || p.startsWith('/') || p.startsWith('-') || p.split(/[\\/]/).includes('..') || p.includes('\0')) {
    throw httpError(400, 'BAD_PATH', `Invalid path: ${p}`);
  }
}

const STATE: Record<string, GitFileState> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflict',
  '?': 'untracked',
};

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(out: string): GitChange[] {
  const parts = out.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const file = entry.slice(3);
    let from: string | undefined;
    if (x === 'R' || x === 'C') {
      from = parts[i + 1];
      i++;
    }
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    const code = conflict ? 'U' : x !== ' ' && x !== '?' ? x : y;
    changes.push({
      path: file,
      ...(from ? { from } : {}),
      state: STATE[code] ?? 'modified',
      staged: !conflict && x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
    });
  }
  return changes;
}

export async function gitChanges(projectPath: string): Promise<GitChange[]> {
  const out = await gitOrThrow(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return parsePorcelainZ(out);
}

const DIFF_LIMIT = 300_000;

/** Unified diff of one file (or everything) against HEAD, incl. untracked files. */
export async function gitDiff(projectPath: string, file?: string): Promise<GitDiffResponse> {
  let out = '';
  if (file) {
    assertRelPath(file);
    const tracked = await git(projectPath, ['ls-files', '--error-unmatch', '--', file]);
    if (tracked.exitCode !== 0) {
      // Untracked: diff against /dev/null (exit code 1 = differences).
      const res = await git(projectPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
      out = res.stdout;
    } else {
      const hasHead = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).exitCode === 0;
      const res = await git(projectPath, ['diff', '--no-color', ...(hasHead ? ['HEAD'] : ['--cached']), '--', file]);
      out = res.stdout;
    }
  } else {
    const res = await git(projectPath, ['diff', '--no-color', 'HEAD']);
    out = res.stdout;
  }
  const binary = /^Binary files .* differ$/m.test(out);
  return { diff: out.slice(0, DIFF_LIMIT), truncated: out.length > DIFF_LIMIT, ...(binary ? { binary } : {}) };
}

export async function gitLog(projectPath: string, limit = 30): Promise<GitCommitInfo[]> {
  const res = await git(projectPath, [
    'log',
    `-n${Math.min(Math.max(1, limit), 200)}`,
    '--date=unix',
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%D%x1e',
  ]);
  if (res.exitCode !== 0) return []; // empty repo
  return res.stdout
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash = '', short = '', subject = '', author = '', ts = '0', refs = ''] = r.split('\x1f');
      return { hash, short, subject, author, ts: Number(ts) * 1000, ...(refs ? { refs } : {}) };
    });
}

export async function gitShow(projectPath: string, hash: string): Promise<GitDiffResponse> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw httpError(400, 'BAD_REF', 'Invalid commit hash.');
  const res = await git(projectPath, ['show', '--no-color', '--stat', '--patch', hash]);
  if (res.exitCode !== 0) throw httpError(404, 'NOT_FOUND', 'Commit not found.');
  return { diff: res.stdout.slice(0, DIFF_LIMIT), truncated: res.stdout.length > DIFF_LIMIT };
}

export async function gitBranches(projectPath: string): Promise<GitBranches> {
  const [local, remote] = await Promise.all([
    gitOrThrow(projectPath, ['branch', '--format=%(HEAD)%(refname:short)']),
    git(projectPath, ['branch', '-r', '--format=%(refname:short)']),
  ]);
  const out: GitBranches = { local: [], remote: [] };
  for (const line of local.split('\n')) {
    const name = line.slice(1).trim();
    if (!name || name.startsWith('(')) continue; // "(HEAD detached at …)"
    if (line.startsWith('*')) out.current = name;
    out.local.push(name);
  }
  for (const line of remote.stdout.split('\n')) {
    const name = line.trim();
    // Skip the symbolic "origin/HEAD" (short form renders as plain "origin").
    if (!name || name.endsWith('/HEAD') || !name.includes('/')) continue;
    out.remote.push(name);
  }
  return out;
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*[~^:?*\[\\\s])[A-Za-z0-9._/-]{1,200}$/;

export async function gitCheckout(projectPath: string, branch: string, create = false): Promise<GitOpResult> {
  if (!BRANCH_RE.test(branch)) throw httpError(400, 'BAD_BRANCH', 'Invalid branch name.');
  // Remote branch → local tracking branch of the same short name.
  const remote = /^(origin|upstream)\/(.+)$/.exec(branch);
  const args = create
    ? ['checkout', '-b', branch]
    : remote
      ? ['checkout', '--track', branch]
      : ['checkout', branch];
  let res = await git(projectPath, args);
  if (res.exitCode !== 0 && remote) res = await git(projectPath, ['checkout', remote[2] as string]);
  const message = (res.stderr || res.stdout).trim();
  return { ok: res.exitCode === 0, message: message.slice(0, 500) || (res.exitCode === 0 ? `On ${branch}` : 'checkout failed') };
}

export async function gitPull(projectPath: string): Promise<GitOpResult> {
  const res = await git(projectPath, ['pull', '--ff-only']);
  const message = (res.stdout || res.stderr).trim();
  return { ok: res.exitCode === 0, message: message.slice(0, 500) || (res.exitCode === 0 ? 'Up to date' : 'pull failed') };
}

export async function gitFetch(projectPath: string): Promise<GitOpResult> {
  const res = await git(projectPath, ['fetch', '--all', '--prune']);
  return { ok: res.exitCode === 0, message: (res.stderr || res.stdout).trim().slice(0, 500) || 'Fetched' };
}

/** Throws away local changes of one file (tracked: restore, untracked: delete). */
export async function gitDiscard(projectPath: string, file: string): Promise<void> {
  assertRelPath(file);
  const tracked = await git(projectPath, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.exitCode !== 0) {
    await gitOrThrow(projectPath, ['clean', '-f', '--', file]);
    return;
  }
  const hasHead = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).exitCode === 0;
  if (hasHead) await gitOrThrow(projectPath, ['checkout', 'HEAD', '--', file]);
  else await gitOrThrow(projectPath, ['rm', '--cached', '-f', '--', file]);
}

/** Staged+unstaged diff summary used as input for an AI commit message. */
export async function gitDiffForMessage(projectPath: string, files?: string[]): Promise<string> {
  const changes = await gitChanges(projectPath);
  const picked = files && files.length ? changes.filter((c) => files.includes(c.path)) : changes;
  if (picked.length === 0) return '';
  const header = picked.map((c) => `${c.state.padEnd(10)} ${c.path}`).join('\n');
  const parts: string[] = [header, ''];
  let budget = 12_000;
  for (const c of picked) {
    if (budget <= 0) break;
    const { diff } = await gitDiff(projectPath, c.path);
    const chunk = diff.slice(0, Math.min(budget, 3_000));
    parts.push(chunk);
    budget -= chunk.length;
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Clone jobs (async, progress-parsed)
// ---------------------------------------------------------------------------

export interface CloneCallbacks {
  onProgress: (percent: number) => void;
}

export function sanitizeCloneName(name: string | undefined, url: string): string {
  const base =
    (name?.trim() ||
      url
        .replace(/\/+$/, '')
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ||
      '').trim();
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug || `repo-${newId('c')}`;
}

export async function findFreeCloneTarget(projectsRoot: string, name: string): Promise<string> {
  let candidate = path.join(projectsRoot, name);
  let i = 2;
  // Never clobber an existing directory.
  for (;;) {
    try {
      await fsp.access(candidate);
      candidate = path.join(projectsRoot, `${name}-${i++}`);
    } catch {
      return candidate;
    }
  }
}

/**
 * Runs `git clone --progress` into projectsRoot. Parses percentage milestones
 * from stderr and reports them via onProgress. Removes the partial directory
 * on failure.
 */
export async function cloneRepo(
  url: string,
  target: string,
  cb: CloneCallbacks,
): Promise<void> {
  await ensureDir(target ? path.dirname(target) : '.');
  let lastPercent = 0;
  const child = execa('git', ['clone', '--progress', url, target], {
    reject: false,
    buffer: false,
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    const matches = chunk.matchAll(/(\d+)%/g);
    for (const m of matches) {
      const percent = Number(m[1]);
      if (Number.isFinite(percent) && percent > lastPercent) {
        lastPercent = percent;
        cb.onProgress(percent);
      }
    }
  });
  const res = await child;
  if (res.exitCode !== 0) {
    await fsp.rm(target, { recursive: true, force: true });
    throw httpError(
      502,
      'CLONE_FAILED',
      `git clone failed: ${(res.stderr || res.stdout || 'unknown error').trim().slice(0, 500)}`,
    );
  }
}
