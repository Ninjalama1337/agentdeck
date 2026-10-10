/**
 * The service's runtime: a stable copy of the server bundle under
 * `${XDG_DATA_HOME:-~/.local/share}/agentdeck/runtime/<version>/`, reached
 * through the symlink `runtime/current`. The unit starts
 * `runtime/current/bin/agentdeck-server`, never the bundle the CLI was started
 * from — that may be an AppImage mount (`/tmp/.mount_*`) that disappears when
 * the app quits. A newer app version copies itself next to the old one and
 * flips the symlink; the last two versions are kept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './exec.js';

export interface RuntimePaths {
  /** `<data home>/agentdeck` */
  dataHome: string;
  runtimeRoot: string;
  /** The symlink the unit goes through. */
  currentLink: string;
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): RuntimePaths {
  // The XDG spec only honors absolute values.
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local/share');
  const dataHome = path.join(xdg, 'agentdeck');
  const runtimeRoot = path.join(dataHome, 'runtime');
  return { dataHome, runtimeRoot, currentLink: path.join(runtimeRoot, 'current') };
}

/** What the unit's ExecStart runs. */
export function launcherPath(paths: RuntimePaths): string {
  return path.join(paths.currentLink, 'bin', 'agentdeck-server');
}

export interface BundleInfo {
  root: string;
  version: string;
  /** Raw version.json — two bundles with the same text are the same build. */
  versionJson: string;
}

const LAUNCHER = path.join('bin', 'agentdeck-server');
const NODE_BIN = path.join('node', 'bin', 'node');

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Checks `root` is a complete packaged bundle and reads its version. */
export function inspectBundle(root: string): BundleInfo {
  const versionFile = path.join(root, 'version.json');
  let versionJson: string;
  let version: unknown;
  try {
    versionJson = fs.readFileSync(versionFile, 'utf8');
    version = (JSON.parse(versionJson) as { version?: unknown }).version;
  } catch {
    throw new CliError(
      `${root} is not a packaged AgentDeck server (no version.json). ` +
        'The service can only be installed from the server bundle that ships with the desktop app; ' +
        'a git checkout uses docs/agentdeck.service (see docs/CONFIG.md).',
    );
  }
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new CliError(`${versionFile} has no usable "version".`);
  }
  for (const part of [LAUNCHER, NODE_BIN]) {
    if (!isFile(path.join(root, part))) throw new CliError(`The server bundle at ${root} is incomplete (missing ${part}).`);
  }
  return { root, version, versionJson };
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Entries of `dir` get owner write access (a bundle copied out of a read-only mount keeps its modes). */
function makeUserWritable(dir: string): void {
  fs.chmodSync(dir, fs.statSync(dir).mode | 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeUserWritable(full);
    else fs.chmodSync(full, fs.statSync(full).mode | 0o200);
  }
}

export interface InstalledRuntime {
  /** The runtime directory `current` should point to. */
  dir: string;
  /** The bundle was copied (false: it already was the runtime, or an identical copy existed). */
  copied: boolean;
  /** A copy of the same version was swapped for a different build. */
  replaced: boolean;
}

/** Makes sure `runtime/<version>` holds this bundle; does not touch `current`. */
export function installRuntime(bundle: BundleInfo, paths: RuntimePaths): InstalledRuntime {
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  const realRoot = realpath(paths.runtimeRoot);
  const realBundle = realpath(bundle.root);
  // Already running from the runtime (e.g. via runtime/current): never copy onto itself.
  if (path.dirname(realBundle) === realRoot) return { dir: realBundle, copied: false, replaced: false };

  const target = path.join(paths.runtimeRoot, bundle.version);
  let replaced = false;
  if (fs.existsSync(target)) {
    let sameBuild = false;
    try {
      sameBuild = fs.readFileSync(path.join(target, 'version.json'), 'utf8') === bundle.versionJson;
      sameBuild &&= isFile(path.join(target, LAUNCHER)) && isFile(path.join(target, NODE_BIN));
    } catch {
      // incomplete leftovers are replaced
    }
    if (sameBuild) {
      const now = new Date();
      fs.utimesSync(target, now, now);
      return { dir: target, copied: false, replaced: false };
    }
    replaced = true;
  }

  const staging = path.join(paths.runtimeRoot, `.install-${bundle.version}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(bundle.root, staging, { recursive: true, verbatimSymlinks: true });
    makeUserWritable(staging);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new CliError(`Could not copy the server to ${paths.runtimeRoot}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (replaced) {
    const aside = path.join(paths.runtimeRoot, `.old-${bundle.version}-${process.pid}`);
    fs.rmSync(aside, { recursive: true, force: true });
    fs.renameSync(target, aside);
    fs.renameSync(staging, target);
    fs.rmSync(aside, { recursive: true, force: true });
  } else {
    fs.renameSync(staging, target);
  }
  const now = new Date();
  fs.utimesSync(target, now, now);
  return { dir: target, copied: true, replaced };
}

/** Atomically points `runtime/current` at `dir` (relative link, so the data dir can move). */
export function switchCurrent(paths: RuntimePaths, dir: string): void {
  const tmp = path.join(paths.runtimeRoot, `.current-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.relative(paths.runtimeRoot, dir), tmp);
  fs.renameSync(tmp, paths.currentLink);
}

/** Where `runtime/current` points right now (real path), if it does. */
export function currentRuntimeDir(paths: RuntimePaths): string | undefined {
  try {
    return fs.realpathSync(paths.currentLink);
  } catch {
    return undefined;
  }
}

/** Version of the runtime in `dir` (version.json, else the directory name). */
export function runtimeVersionOf(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string') return parsed.version;
  } catch {
    // fall back to the name
  }
  return fs.existsSync(dir) ? path.basename(dir) : undefined;
}

const STALE_TEMP_MS = 10 * 60_000;

/**
 * Removes old runtimes: keeps the one `current` points to plus the most
 * recently installed others, `keep` in total. Returns the removed versions.
 */
export function pruneRuntimes(paths: RuntimePaths, keep = 2): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.runtimeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const current = currentRuntimeDir(paths);
  const now = Date.now();
  const versions: { name: string; full: string; mtime: number }[] = [];
  for (const entry of entries) {
    const full = path.join(paths.runtimeRoot, entry.name);
    if (entry.name.startsWith('.')) {
      // Leftovers of an interrupted install (not one that may still be running).
      if (/^\.(install|old|current)-/.test(entry.name) && now - fs.lstatSync(full).mtimeMs > STALE_TEMP_MS) {
        fs.rmSync(full, { recursive: true, force: true });
      }
      continue;
    }
    if (entry.name === 'current' || !entry.isDirectory()) continue;
    versions.push({ name: entry.name, full, mtime: fs.statSync(full).mtimeMs });
  }
  versions.sort((a, b) => b.mtime - a.mtime);
  const kept = new Set<string>();
  if (current && path.dirname(current) === realpath(paths.runtimeRoot)) kept.add(path.basename(current));
  for (const v of versions) {
    if (kept.size >= keep) break;
    kept.add(v.name);
  }
  const removed: string[] = [];
  for (const v of versions) {
    if (kept.has(v.name)) continue;
    fs.rmSync(v.full, { recursive: true, force: true });
    removed.push(v.name);
  }
  return removed;
}

/** Deletes the whole runtime tree (uninstall) unless `runningFrom` lives inside it. Returns whether it was removed. */
export function removeRuntime(paths: RuntimePaths, runningFrom?: string): boolean {
  if (!fs.existsSync(paths.runtimeRoot)) return false;
  if (runningFrom !== undefined) {
    const root = realpath(paths.runtimeRoot);
    const here = realpath(runningFrom);
    if (here === root || here.startsWith(root + path.sep)) return false;
  }
  fs.rmSync(paths.runtimeRoot, { recursive: true, force: true });
  return true;
}
