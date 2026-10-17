/**
 * In-app file editing: content read/write, entry create/rename/delete, entry
 * info. Every path is
 * sandbox-resolved (realpath, no traversal) and `.git/` internals are blocked
 * outright. Writes are atomic (temp file in the target dir + rename) and push
 * watcher-style change events through the same batching pipeline as fs.watch,
 * so every client sees one `files:changed` stream.
 */
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileContentResponse, FileInfoResponse, RenameEntryResponse, SaveFileResponse } from '@agentdeck/shared';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import { assertNotGitPath, resolveInsideRoot } from '../files/sandbox.js';
import { guessMime } from '../files/browser.js';
import { EDIT_TEMP_PREFIX } from '../files/watcher.js';
import { isInside } from '../util/paths.js';
import { getProjectOr404 } from './projects.js';
import type { AppDeps } from './deps.js';

/** Hard cap for content reads and writes (1 MB). */
export const FILE_CONTENT_CAP = 1_048_576;
/** Number of leading bytes scanned for NUL bytes (binary detection). */
const BINARY_SNIFF_BYTES = 8000;

const pathSchema = z.string().min(1).max(512);

const toPosix = (p: string): string => p.split(path.sep).join('/');

function errno(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? '';
}

async function entryExists(abs: string): Promise<boolean> {
  try {
    await fsp.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Common sandbox + git-path validation for an edit-style path argument. */
async function resolveEditable(projectPath: string, relPath: string) {
  assertNotGitPath(toPosix(relPath));
  const resolved = await resolveInsideRoot(projectPath, relPath);
  assertNotGitPath(resolved.rel);
  if (resolved.rel === '') {
    throw httpError(400, 'INVALID_PATH', 'Path must name a file or directory inside the project, not the project root.');
  }
  return resolved;
}

/**
 * Like `resolveEditable`, but the last segment is not followed: a symlink is
 * renamed or described itself, not the file it points to.
 */
async function resolveEntry(projectPath: string, relPath: string): Promise<{ abs: string; rel: string }> {
  assertNotGitPath(toPosix(relPath));
  const clean = toPosix(relPath).replace(/\/+$/, '');
  const name = path.posix.basename(clean);
  if (name === '' || name === '.' || name === '..') {
    throw httpError(400, 'INVALID_PATH', 'Path must name a file or directory inside the project, not the project root.');
  }
  const parent = await resolveInsideRoot(projectPath, path.posix.dirname(clean));
  const rel = path.join(parent.rel, name);
  assertNotGitPath(toPosix(rel));
  return { abs: path.join(parent.abs, name), rel };
}

/** `rwxr-xr-x` for the permission bits of `mode`. */
export function permissionString(mode: number): string {
  const flags = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? flags[i] : '-';
  return out;
}

/**
 * Atomic write: temp file inside a mkdtemp dir next to the target, then
 * rename over it. Parent directories are created (the full target path was
 * sandbox-checked up front, so this stays inside the project).
 */
async function atomicWrite(absDir: string, absTarget: string, content: string): Promise<number> {
  await fsp.mkdir(absDir, { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(absDir, EDIT_TEMP_PREFIX));
  const tmpFile = path.join(tmpDir, 'file');
  try {
    await fsp.writeFile(tmpFile, content, 'utf8');
    await fsp.rename(tmpFile, absTarget);
  } catch (err) {
    await fsp.rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fsp.rmdir(tmpDir).catch(() => undefined);
  }
  return Buffer.byteLength(content, 'utf8');
}

export async function fileEditRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  // Read --------------------------------------------------------------------

  fastify.get('/projects/:id/files/content', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z.object({ path: pathSchema }).parse(req.query ?? {});
    const resolved = await resolveEditable(project.path, query.path);
    deps.fileWatchers.ensureStarted(project.id, project.path);

    let fh: FileHandle;
    try {
      fh = await fsp.open(resolved.abs, 'r');
    } catch (err) {
      if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') throw notFound('File not found');
      throw err;
    }
    try {
      const stats = await fh.stat();
      if (stats.isDirectory()) throw httpError(400, 'IS_DIRECTORY', 'Path is a directory, not a file.');

      const toRead = Math.min(stats.size, FILE_CONTENT_CAP);
      const buf = Buffer.alloc(toRead);
      let read = 0;
      while (read < toRead) {
        const { bytesRead } = await fh.read(buf, read, toRead - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      // Binary guard: a NUL byte in the first 8 KB disqualifies the editor.
      const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, read));
      if (sniff.includes(0)) {
        throw httpError(415, 'NON_TEXT', 'File looks binary (NUL byte) and cannot be edited as text.');
      }
      const body: FileContentResponse = {
        path: query.path,
        content: buf.subarray(0, read).toString('utf8'),
        size: stats.size,
        mime: guessMime(resolved.abs),
        truncated: stats.size > FILE_CONTENT_CAP,
      };
      return body;
    } finally {
      await fh.close();
    }
  });

  // Write -------------------------------------------------------------------

  fastify.put('/projects/:id/files/content', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z
      .object({ path: pathSchema, content: z.string().max(FILE_CONTENT_CAP) })
      .parse(req.body);
    const resolved = await resolveEditable(project.path, body.path);
    if (body.content.includes('\0')) {
      throw httpError(415, 'NON_TEXT', 'Content contains NUL bytes and cannot be saved as text.');
    }
    deps.fileWatchers.ensureStarted(project.id, project.path);

    let existed = false;
    const current = await fsp.lstat(resolved.abs).catch(() => undefined);
    if (current) {
      if (current.isDirectory()) throw httpError(400, 'IS_DIRECTORY', 'Path is a directory, not a file.');
      existed = true;
    }
    const size = await atomicWrite(path.dirname(resolved.abs), resolved.abs, body.content);
    deps.fileWatchers.push(project.id, {
      type: existed ? 'change' : 'create',
      path: toPosix(resolved.rel),
    });
    const result: SaveFileResponse = { path: body.path, size, savedAt: Date.now() };
    return result;
  });

  // Create ------------------------------------------------------------------

  fastify.post('/projects/:id/files/create', async (req, reply) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z
      .object({ path: pathSchema, kind: z.enum(['file', 'dir']) })
      .parse(req.body);
    const resolved = await resolveEditable(project.path, body.path);
    deps.fileWatchers.ensureStarted(project.id, project.path);

    if (await entryExists(resolved.abs)) {
      throw httpError(409, 'EXISTS', 'An entry with this path already exists.');
    }
    if (body.kind === 'dir') {
      await fsp.mkdir(resolved.abs, { recursive: true });
    } else {
      await atomicWrite(path.dirname(resolved.abs), resolved.abs, '');
    }
    deps.fileWatchers.push(project.id, { type: 'create', path: toPosix(resolved.rel) });
    reply.code(204).send();
  });

  // Rename ------------------------------------------------------------------

  fastify.post('/projects/:id/files/rename', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z.object({ from: pathSchema, to: pathSchema }).parse(req.body);
    const from = await resolveEntry(project.path, body.from);
    const to = await resolveEntry(project.path, body.to);
    deps.fileWatchers.ensureStarted(project.id, project.path);

    const stats = await fsp.lstat(from.abs).catch(() => undefined);
    if (!stats) throw notFound('Entry not found');
    const result: RenameEntryResponse = { path: toPosix(to.rel) };
    if (from.abs === to.abs) return result;
    const existing = await fsp.lstat(to.abs).catch(() => undefined);
    // Same inode: only the case changes on a case-insensitive filesystem.
    if (existing && existing.ino !== stats.ino) {
      throw httpError(409, 'EXISTS', 'An entry with this path already exists.');
    }
    if (stats.isDirectory() && isInside(from.abs, to.abs)) {
      throw httpError(400, 'INVALID_PATH', 'A folder cannot be moved into itself.');
    }
    await fsp.mkdir(path.dirname(to.abs), { recursive: true });
    await fsp.rename(from.abs, to.abs);
    deps.fileWatchers.push(project.id, { type: 'delete', path: toPosix(from.rel) });
    deps.fileWatchers.push(project.id, { type: 'create', path: toPosix(to.rel) });
    return result;
  });

  // Info --------------------------------------------------------------------

  fastify.get('/projects/:id/files/info', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z.object({ path: pathSchema }).parse(req.query ?? {});
    const entry = await resolveEntry(project.path, query.path);

    const link = await fsp.lstat(entry.abs).catch(() => undefined);
    if (!link) throw notFound('Entry not found');
    const isLink = link.isSymbolicLink();
    // A link describes what it points to; a broken one describes itself.
    const stats = isLink ? await fsp.stat(entry.abs).catch(() => link) : link;
    const isDir = stats.isDirectory();
    const info: FileInfoResponse = {
      path: toPosix(entry.rel),
      name: path.basename(entry.abs),
      kind: isDir ? 'dir' : 'file',
      absPath: entry.abs,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      permissions: permissionString(stats.mode),
    };
    if (stats.birthtimeMs > 0) info.createdAt = stats.birthtimeMs;
    if (isDir) info.items = (await fsp.readdir(entry.abs).catch(() => [])).length;
    else info.mime = guessMime(entry.abs);
    if (isLink) info.symlinkTarget = await fsp.readlink(entry.abs);
    return info;
  });

  // Delete ------------------------------------------------------------------

  fastify.delete('/projects/:id/files/entry', async (req, reply) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z
      .object({ path: pathSchema, recursive: z.string().optional() })
      .parse(req.query ?? {});
    const recursive = query.recursive === '1';
    const resolved = await resolveEditable(project.path, query.path);
    deps.fileWatchers.ensureStarted(project.id, project.path);

    const stats = await fsp.lstat(resolved.abs).catch(() => undefined);
    if (!stats) throw notFound('Entry not found');

    if (stats.isDirectory()) {
      try {
        await fsp.rmdir(resolved.abs); // refuses non-empty dirs
      } catch (err) {
        if (errno(err) !== 'ENOTEMPTY') throw err;
        if (!recursive) {
          throw httpError(409, 'DIR_NOT_EMPTY', 'Directory is not empty — pass recursive=1 to delete it with its contents.');
        }
        await fsp.rm(resolved.abs, { recursive: true, force: true });
      }
    } else {
      await fsp.unlink(resolved.abs);
    }
    deps.fileWatchers.push(project.id, { type: 'delete', path: toPosix(resolved.rel) });
    reply.code(204).send();
  });
}
