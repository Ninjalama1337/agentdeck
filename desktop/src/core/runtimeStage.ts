import path from 'node:path';
import type { FileSystem } from './fs';

/**
 * The AppImage runtime mounts the app on a short-lived FUSE mount; when the app
 * exits, the mount (and every file mapped from it) goes away. A server that is
 * meant to outlive the app must therefore run from a copy outside of it.
 */
export function isVolatilePath(file: string, env: NodeJS.ProcessEnv): boolean {
  const appDir = env.APPDIR;
  if (appDir && (file === appDir || file.startsWith(`${appDir}/`))) return true;
  return /^\/tmp\/\.mount_[^/]+(\/|$)/.test(file);
}

const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

/**
 * Makes sure `<runtimeDir>/<version>` holds a copy of the bundle and returns the
 * CLI inside it. Same layout `agentdeck-server service install` uses, so a later
 * service install finds (or replaces) the very same directory.
 */
export async function stageRuntime(options: {
  fs: FileSystem;
  bundleRoot: string;
  version: string;
  runtimeDir: string;
  pid: number;
}): Promise<string> {
  const { fs, bundleRoot, version, runtimeDir } = options;
  if (!VERSION_SHAPE.test(version)) throw new Error(`Refusing to stage a runtime for version "${version}"`);
  const target = path.join(runtimeDir, version);
  const bin = path.join(target, 'bin', 'agentdeck-server');
  if (await fs.exists(bin)) return bin;

  await fs.mkdirp(runtimeDir);
  const partial = path.join(runtimeDir, `.staging-${version}-${options.pid}`);
  await fs.remove(partial);
  await fs.copyDir(bundleRoot, partial);
  await fs.makeUserWritable(partial);
  await fs.rename(partial, target);
  return bin;
}
