import path from 'node:path';
import type { FileSystem } from '../../src/core/fs';

/** In-memory FileSystem for the core tests. */
export class MemFs implements FileSystem {
  readonly files = new Map<string, { data: string; mode?: number }>();
  readonly dirs = new Set<string>();
  readonly links = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [file, data] of Object.entries(initial)) this.files.set(file, { data });
  }

  async readFile(file: string): Promise<string> {
    const entry = this.files.get(file);
    if (!entry) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return entry.data;
  }
  async writeFile(file: string, data: string, mode?: number): Promise<void> {
    this.files.set(file, { data, ...(mode !== undefined ? { mode } : {}) });
  }
  async mkdirp(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
  async rename(from: string, to: string): Promise<void> {
    const entry = this.files.get(from);
    if (entry) {
      this.files.delete(from);
      this.files.set(to, entry);
      return;
    }
    // directory rename: move everything below
    const prefix = `${from}/`;
    let moved = false;
    for (const [file, value] of [...this.files]) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
        this.files.set(path.join(to, file.slice(prefix.length)), value);
        moved = true;
      }
    }
    if (!moved) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
  }
  async remove(file: string): Promise<void> {
    this.files.delete(file);
    this.links.delete(file);
    for (const key of [...this.files.keys()]) if (key.startsWith(`${file}/`)) this.files.delete(key);
  }
  async exists(file: string): Promise<boolean> {
    return this.files.has(file) || this.dirs.has(file) || this.links.has(file);
  }
  async size(file: string): Promise<number | null> {
    const entry = this.files.get(file);
    return entry ? entry.data.length : null;
  }
  async copyDir(from: string, to: string): Promise<void> {
    const prefix = `${from}/`;
    for (const [file, value] of [...this.files]) {
      if (file.startsWith(prefix)) this.files.set(path.join(to, file.slice(prefix.length)), { ...value });
    }
  }
  async symlink(target: string, link: string): Promise<void> {
    this.links.set(link, target);
  }
}
