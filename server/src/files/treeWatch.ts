/**
 * Recursive watching for Linux, one inotify watch per FOLDER.
 *
 * Node's own `fs.watch(dir, { recursive: true })` emulates recursion on Linux
 * with one watch per file AND folder — node_modules included. A few projects
 * with dependencies used up the whole per-user inotify budget (524 288), and
 * from then on every watcher on the machine (editors, dev servers, our own)
 * silently missed events. A folder watch already reports changes to the files
 * inside it, so watching folders is enough; dependency trees and caches are
 * not descended into at all.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Folder names never descended into — dependency trees and caches, often 100k+ entries. */
export const UNWATCHED_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.godot',
  'target',
]);

/** Folders one project may watch; deeper/larger trees go without live events past it. */
export const MAX_WATCHED_DIRS = 4096;

export interface TreeWatcher {
  close(): void;
}

export interface TreeWatchOptions {
  /** `rel`: POSIX path relative to the root. */
  onChange: (type: 'rename' | 'change', rel: string) => void;
  /** The root's own watch failed (gone, or out of watches). */
  onError: (err: Error) => void;
  /** Called once when `maxDirs` is reached. */
  onCapped?: () => void;
  maxDirs?: number;
}

/** Watches `root` and its folders. Throws when the root itself cannot be watched. */
export function watchTree(root: string, opts: TreeWatchOptions): TreeWatcher {
  const maxDirs = opts.maxDirs ?? MAX_WATCHED_DIRS;
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;
  let capped = false;

  const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

  const unwatch = (rel: string): void => {
    for (const [dir, watcher] of watchers) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
  };

  /** A folder appeared (watch it) or went away (drop its watches). */
  const track = async (rel: string): Promise<void> => {
    if (UNWATCHED_DIRS.has(path.posix.basename(rel))) return;
    const stats = await fsp.lstat(path.join(root, rel)).catch(() => undefined);
    if (closed) return;
    if (!stats) unwatch(rel);
    else if (stats.isDirectory()) watchDir(rel, true);
  };

  /**
   * Watches what is already inside. `announce`: report it too — in a folder
   * that was just created, files can land before its watch exists
   * (`mkdir -p a/b && touch a/b/c`).
   */
  const scan = async (rel: string, announce: boolean): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (closed) return;
      const child = join(rel, entry.name);
      if (announce) opts.onChange('rename', child);
      if (entry.isDirectory() && !UNWATCHED_DIRS.has(entry.name)) watchDir(child, announce);
    }
  };

  const watchDir = (rel: string, announce: boolean): void => {
    if (closed || watchers.has(rel)) return;
    if (watchers.size >= maxDirs) {
      if (!capped) {
        capped = true;
        opts.onCapped?.();
      }
      return;
    }
    const abs = path.join(root, rel);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(abs, { persistent: false }, (eventType, name) => {
        if (closed || name === null) return;
        // The folder itself went away — its parent reports the delete.
        if (rel !== '' && !fs.existsSync(abs)) {
          unwatch(rel);
          return;
        }
        const child = join(rel, String(name));
        opts.onChange(eventType === 'change' ? 'change' : 'rename', child);
        if (eventType === 'rename') void track(child);
      });
    } catch (err) {
      if (rel === '') throw err;
      return; // vanished or unreadable in the meantime
    }
    watcher.on('error', (err) => {
      if (rel === '') opts.onError(err);
      else unwatch(rel);
    });
    watchers.set(rel, watcher);
    void scan(rel, announce);
  };

  watchDir('', false);
  return {
    close() {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
