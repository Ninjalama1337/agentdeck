/**
 * Every file path of a project, for quick open. A git repository lists what
 * git sees (tracked + untracked, ignores honoured); anything else is walked,
 * skipping the usual dependency and build folders. Capped — quick open needs
 * names, not a full inventory of a monorepo.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export const FILE_INDEX_LIMIT = 20_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache']);

export interface FileIndex {
  paths: string[];
  truncated: boolean;
}

async function fromGit(root: string, limit: number): Promise<FileIndex | null> {
  const res = await execa('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    reject: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.exitCode !== 0) return null;
  // Deleted-but-tracked files still show up under --cached; quick open only offers what exists.
  const all = [...new Set(String(res.stdout).split('\0').filter(Boolean))];
  return { paths: all.slice(0, limit), truncated: all.length > limit };
}

async function walk(root: string, limit: number): Promise<FileIndex> {
  const paths: string[] = [];
  const queue = [''];
  while (queue.length && paths.length < limit) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) {
        paths.push(child);
        if (paths.length >= limit) break;
      }
    }
  }
  return { paths, truncated: paths.length >= limit };
}

export async function fileIndex(root: string, limit = FILE_INDEX_LIMIT): Promise<FileIndex> {
  return (await fromGit(root, limit).catch(() => null)) ?? walk(root, limit);
}
