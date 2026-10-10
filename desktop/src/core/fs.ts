import fsp from 'node:fs/promises';
import path from 'node:path';

/** The few file operations the core needs — injectable so tests need no disk. */
export interface FileSystem {
  /** UTF-8 text; rejects when the file is missing. */
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string, mode?: number): Promise<void>;
  /** Creates the directory and its parents. */
  mkdirp(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or symlink; no error when it is already gone. */
  remove(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  /** Size in bytes, or null when the file does not exist. */
  size(file: string): Promise<number | null>;
  /** Recursive copy keeping modes and symlinks. */
  copyDir(from: string, to: string): Promise<void>;
  /** Replaces `link` with a symlink to `target`. */
  symlink(target: string, link: string): Promise<void>;
}

export const nodeFs: FileSystem = {
  readFile: (file) => fsp.readFile(file, 'utf8'),
  async writeFile(file, data, mode) {
    await fsp.writeFile(file, data, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  },
  async mkdirp(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
  rename: (from, to) => fsp.rename(from, to),
  remove: (file) => fsp.rm(file, { recursive: true, force: true }),
  async exists(file) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  },
  async size(file) {
    try {
      return (await fsp.stat(file)).size;
    } catch {
      return null;
    }
  },
  async copyDir(from, to) {
    await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  },
  async symlink(target, link) {
    const tmp = `${link}.tmp-${process.pid}`;
    await fsp.rm(tmp, { force: true });
    await fsp.symlink(target, tmp);
    await fsp.rename(tmp, link);
  },
};

/** Write-then-rename, so a crash never leaves a half-written file behind. */
export async function writeFileAtomic(fs: FileSystem, file: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdirp(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data, mode);
  await fs.rename(tmp, file);
}

/** JSON file with defaults: a missing or corrupt file reads as the default. */
export async function readJsonFile(fs: FileSystem, file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file)) as unknown;
  } catch {
    return undefined;
  }
}
