import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Expands a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Sanitizes a user-provided filename: no separators, no control chars, bounded length. */
export function sanitizeFileName(name: string): string {
  const base = path.basename(name ?? '');
  const cleaned = base
    // eslint-disable-next no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const safe = cleaned.length > 0 ? cleaned : 'file';
  return safe.length > 120 ? safe.slice(0, 120) : safe;
}

/** True when `child` equals `root` or lives underneath it (lexicographic check). */
export function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
