/**
 * Folder picker: lists directories under a configured browse root so an
 * existing repo elsewhere on the machine can be adopted as a project.
 * Every path is realpath-resolved and must stay inside the root.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrowseEntry, BrowseResponse } from '@agentdeck/shared';
import { expandHome, isInside } from '../util/paths.js';
import { httpError } from '../http/errors.js';

/** Real (symlink-resolved) absolute path of the browse root. */
export async function resolveBrowseRoot(root: string): Promise<string> {
  const rootAbs = path.resolve(expandHome(root));
  try {
    return await fsp.realpath(rootAbs);
  } catch {
    throw httpError(500, 'BROWSE_ROOT_MISSING', `Browse root ${rootAbs} does not exist.`);
  }
}

/**
 * Resolves `requested` (absolute, or relative to the root) to an existing
 * directory inside `rootReal`. Rejects traversal and symlink escapes.
 */
export async function resolveBrowseDir(rootReal: string, requested?: string): Promise<string> {
  const target = requested && requested.trim() ? path.resolve(rootReal, requested) : rootReal;
  let targetReal: string;
  try {
    targetReal = await fsp.realpath(target);
  } catch {
    throw httpError(404, 'NOT_FOUND', 'Directory not found');
  }
  if (!isInside(rootReal, targetReal)) {
    throw httpError(403, 'FORBIDDEN', 'Path escapes the browse root.');
  }
  const stats = await fsp.stat(targetReal);
  if (!stats.isDirectory()) throw httpError(400, 'NOT_A_DIRECTORY', 'Not a directory');
  return targetReal;
}

async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    await fsp.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Lists the sub-directories of `dir`. Dot-directories are hidden unless `all`. */
export async function listBrowseDirs(
  rootReal: string,
  dir: string,
  opts: { all?: boolean } = {},
): Promise<BrowseResponse> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    throw httpError(404, 'NOT_FOUND', 'Directory not found');
  }

  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (!opts.all && dirent.name.startsWith('.')) continue;
    const abs = path.join(dir, dirent.name);
    // Follow symlinks to decide whether the target is a directory; skip escapes.
    let isDir = dirent.isDirectory();
    let real = abs;
    try {
      real = await fsp.realpath(abs);
      isDir = (await fsp.stat(abs)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir || !isInside(rootReal, real)) continue;
    const entry: BrowseEntry = { name: dirent.name, path: real };
    if (await isGitWorkTree(real)) entry.isGitRepo = true;
    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (Boolean(a.isGitRepo) !== Boolean(b.isGitRepo)) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentReal = dir === rootReal ? undefined : path.dirname(dir);
  const res: BrowseResponse = { path: dir, root: rootReal, entries };
  if (parentReal && isInside(rootReal, parentReal)) res.parent = parentReal;
  return res;
}
