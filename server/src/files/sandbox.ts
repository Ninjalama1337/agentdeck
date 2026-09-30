/**
 * File sandbox: every filesystem access resolves (realpath) and must stay
 * inside the sandbox root — no traversal, no absolute-path injection, no
 * symlink escape.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { expandHome, isInside } from '../util/paths.js';
import { httpError } from '../http/errors.js';

export interface ResolvedPath {
  /** Real (symlink-resolved) absolute path, guaranteed inside the root. */
  abs: string;
  /** Path relative to the resolved root. */
  rel: string;
  root: string;
}

function forbidden(detail: string): never {
  throw httpError(403, 'FORBIDDEN', `Path escapes the sandbox: ${detail}`);
}

/**
 * True when any path segment is `.git` (case-insensitive) — such paths are
 * git internals and are blocked for edits/deletes and excluded from watcher
 * events. Operates on forward-slash relative paths (sandbox `rel` form).
 */
export function isGitInternalPath(rel: string): boolean {
  return rel.split('/').some((segment) => segment.toLowerCase() === '.git');
}

/** Rejects `.git`-internal paths with 403 FORBIDDEN_PATH. */
export function assertNotGitPath(rel: string): void {
  if (isGitInternalPath(rel)) {
    throw httpError(403, 'FORBIDDEN_PATH', 'Paths inside .git/ are managed by git and cannot be edited here.');
  }
}

/**
 * Resolves `relPath` (relative, or an attempted absolute injection) inside
 * `root`. Creates the root when `create` is set (first use of a project dir).
 */
export async function resolveInsideRoot(
  root: string,
  relPath: string,
  opts: { create?: boolean } = {},
): Promise<ResolvedPath> {
  const rootAbs = path.resolve(expandHome(root));
  if (opts.create) {
    await fsp.mkdir(rootAbs, { recursive: true });
  }
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(rootAbs);
  } catch {
    forbidden(`root ${rootAbs} does not exist`);
  }

  // path.resolve absorbs absolute-path injection attempts; the containment
  // check below catches them.
  const target = path.resolve(rootReal, relPath ?? '');
  if (!isInside(rootReal, target)) {
    forbidden(String(relPath));
  }

  let targetReal: string;
  try {
    targetReal = await fsp.realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Not-yet-existing target (e.g. upload destination): validate the
      // deepest existing ancestor so a symlinked parent can't escape.
      let existing = path.dirname(target);
      for (;;) {
        try {
          const real = await fsp.realpath(existing);
          if (!isInside(rootReal, real)) forbidden(`parent ${existing} resolves outside the root`);
          targetReal = path.join(real, path.relative(existing, target));
          break;
        } catch {
          const next = path.dirname(existing);
          if (next === existing) forbidden(`root ${rootReal} disappeared`);
          existing = next;
        }
      }
    } else {
      throw err;
    }
  }
  if (!isInside(rootReal, targetReal)) {
    forbidden(`${relPath} resolves to ${targetReal}`);
  }
  return { abs: targetReal, rel: path.relative(rootReal, targetReal), root: rootReal };
}
