/**
 * Directory listing + attachment/mime helpers for the file browser API.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '@agentdeck/shared';
import { httpError } from '../http/errors.js';

export interface ListOptions {
  /** Include dotfiles (query `all=1`). */
  all?: boolean;
}

/** Lists a directory (already sandbox-resolved). Dirs first, then names. */
export async function listDirectory(absDir: string, relBase: string, opts: ListOptions = {}): Promise<FileEntry[]> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw httpError(404, 'NOT_FOUND', 'Directory not found');
    if (code === 'ENOTDIR') throw httpError(400, 'NOT_A_DIRECTORY', 'Not a directory');
    throw err;
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (!opts.all && dirent.name.startsWith('.')) continue;
    // node_modules is listed itself but never traversed (we never recurse anyway).
    const abs = path.join(absDir, dirent.name);
    let isDir = dirent.isDirectory();
    let size: number | undefined;
    let mtimeMs: number | undefined;
    try {
      const stats = await fsp.stat(abs); // follows symlinks → correct kind/size
      isDir = stats.isDirectory();
      size = isDir ? undefined : stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Broken symlink → keep the entry with unknown size.
    }
    const entry: FileEntry = {
      name: dirent.name,
      path: relBase ? `${relBase}/${dirent.name}` : dirent.name,
      kind: isDir ? 'dir' : 'file',
    };
    if (size !== undefined) entry.size = size;
    if (!isDir) {
      const ext = path.extname(dirent.name).slice(1).toLowerCase();
      if (ext) entry.ext = ext;
    }
    if (mtimeMs !== undefined) entry.modifiedAt = mtimeMs;
    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/** Compact extension → MIME map (renderable subset + common project files). */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
};

/** MIME guess with a safe default. */
export function guessMime(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Content-Disposition inline whitelist (renderable in browsers/webviews). */
export function isInlineMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript'
  );
}
