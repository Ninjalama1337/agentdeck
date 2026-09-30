/**
 * Git operations executed inside project directories (via execa `git -C`).
 */
import { execa } from 'execa';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProjectGitInfo } from '@agentdeck/shared';
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
): Promise<ProjectGitInfo> {
  if (all) await gitOrThrow(projectPath, ['add', '-A']);
  await gitOrThrow(projectPath, ['commit', '-m', message]);
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
