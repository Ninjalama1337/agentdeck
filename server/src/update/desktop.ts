/**
 * Remote update of the desktop app (AppImage) by the server it ships with —
 * Settings → Server update on the phone, nobody at the computer:
 *
 *   1. read `latest-linux.yml` of the release (file name + SHA-512),
 *   2. download the new AppImage next to the old one and verify it,
 *   3. extract the server bundle from it (`--appimage-extract`, no FUSE),
 *   4. put the new AppImage in place of the old one,
 *   5. `agentdeck-server service install` from the new bundle: it stages the
 *      runtime and restarts the service — this process ends there.
 *
 * Step 5 runs detached (own session, output into update.log): the unit has
 * KillMode=process, so it outlives the restart of this server.
 *
 * Where the app lives: the desktop app records itself in
 * `<dataDir>/desktop-app.json` on every start; older apps are found through
 * their autostart or menu entry. A .deb install cannot be updated this way
 * (it needs root) — the app does that itself at start.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execa } from 'execa';
import type { ReleaseInfo } from './release.js';

/** Written by the desktop app (desktop/src/core/registration.ts). */
export const DESKTOP_APP_FILE = 'desktop-app.json';

export type DesktopApp = { kind: 'appimage'; path: string } | { kind: 'deb' };

const DEB_EXECUTABLE = '/opt/AgentDeck/agentdeck';

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The AppImage an `Exec=` line launches (`env VAR=1 /path/x.AppImage --flag %U` included). */
export function appImageFromExec(exec: string): string | undefined {
  for (const raw of exec.match(/"[^"]*"|\S+/g) ?? []) {
    const token = raw.replace(/^"|"$/g, '');
    if (path.isAbsolute(token) && /\.appimage$/i.test(token)) return token;
  }
  return undefined;
}

function execLine(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!/agentdeck/i.test(text)) return undefined;
    return /^Exec=(.*)$/m.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/** Desktop entries that may launch the app: the autostart entry first, then menu entries. */
function desktopEntries(env: NodeJS.ProcessEnv, home: string): string[] {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const apps = path.join(data, 'applications');
  let menu: string[] = [];
  try {
    menu = fs
      .readdirSync(apps)
      .filter((f) => f.endsWith('.desktop') && /agentdeck/i.test(f))
      .map((f) => path.join(apps, f));
  } catch {
    /* no menu entries */
  }
  return [path.join(config, 'autostart', 'agentdeck.desktop'), ...menu];
}

/** Where the desktop app is installed, or null when this machine has none we know of. */
export function findDesktopApp(opts: { dataDir: string; env?: NodeJS.ProcessEnv; home?: string; debExecutable?: string }): DesktopApp | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(opts.dataDir, DESKTOP_APP_FILE), 'utf8')) as { appImage?: unknown; packageType?: unknown };
    if (typeof reg.appImage === 'string' && path.isAbsolute(reg.appImage) && isFile(reg.appImage)) return { kind: 'appimage', path: reg.appImage };
    if (reg.packageType === 'deb') return { kind: 'deb' };
  } catch {
    /* not recorded (yet) — look at the desktop entries */
  }
  for (const entry of desktopEntries(env, home)) {
    const exec = execLine(entry);
    const appImage = exec ? appImageFromExec(exec) : undefined;
    if (appImage && isFile(appImage)) return { kind: 'appimage', path: appImage };
  }
  if (isFile(opts.debExecutable ?? DEB_EXECUTABLE)) return { kind: 'deb' };
  return null;
}

/** `path` and `sha512` of electron-builder's `latest-linux.yml` (top-level keys: the AppImage). */
export function parseLatestLinuxYml(text: string): { file: string; sha512: string; size?: number } {
  const top = (key: string) => new RegExp(`^${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm').exec(text)?.[1];
  const file = top('path');
  const sha512 = top('sha512');
  if (!file || !sha512 || !/\.AppImage$/i.test(file) || file.includes('/')) {
    throw new Error('latest-linux.yml of the release names no AppImage.');
  }
  const size = /^\s+size:\s*(\d+)\s*$/m.exec(text)?.[1];
  return { file, sha512, ...(size ? { size: Number(size) } : {}) };
}

export interface DesktopUpdateOptions {
  appImage: string;
  release: ReleaseInfo;
  repo: string;
  dataDir: string;
  /** update.log: the detached last step writes here. */
  logFile: string;
  push(line: string): void;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function download(url: string, target: string, opts: DesktopUpdateOptions, expectedSize?: number): Promise<string> {
  const res = await (opts.fetch ?? fetch)(url, { signal: opts.signal, headers: { 'user-agent': 'agentdeck-server' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(target, { mode: 0o755 });
  let done = 0;
  let nextStep = 10;
  try {
    for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
      const buf = chunk as Buffer;
      hash.update(buf);
      done += buf.length;
      if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      if (total > 0 && (done * 100) / total >= nextStep) {
        opts.push(`  ${nextStep}% (${mb(done)} of ${mb(total)})`);
        nextStep += 10;
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return hash.digest('base64');
}

/** `service status --json` of the new bundle: is the server ours, as a unit, and listening on the LAN? */
async function serviceStatus(bin: string): Promise<{ installed: boolean; managed: boolean; lan: boolean }> {
  const res = await execa(bin, ['service', 'status', '--json'], { reject: false, timeout: 30_000, stdin: 'ignore' });
  if (res.exitCode !== 0) throw new Error(`agentdeck-server service status failed: ${String(res.stderr).trim().slice(-300)}`);
  const text = String(res.stdout);
  const status = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
  return { installed: status.installed === true, managed: status.managed === true, lan: status.lan === true };
}

/** Runs steps 1–5. Resolves when the new app is in place (and, as a unit, the service install did not fail). */
export async function runDesktopUpdate(opts: DesktopUpdateOptions): Promise<void> {
  const { release, push } = opts;
  const base = `https://github.com/${opts.repo}/releases/download/${release.tag}`;
  // Replace the file itself, not a symlink to it.
  const target = await fsp.realpath(opts.appImage);
  const work = path.join(opts.dataDir, 'desktop-update');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.update-${process.pid}`);

  try {
    push(`Desktop app: ${target}`);
    const ymlRes = await (opts.fetch ?? fetch)(`${base}/latest-linux.yml`, { signal: opts.signal, headers: { 'user-agent': 'agentdeck-server' } });
    if (ymlRes.status === 404) throw new Error(`The desktop packages of ${release.tag} are not published yet — try again in a few minutes.`);
    if (!ymlRes.ok) throw new Error(`Could not read latest-linux.yml (HTTP ${ymlRes.status}).`);
    const meta = parseLatestLinuxYml(await ymlRes.text());

    push(`Downloading ${meta.file}${meta.size ? ` (${mb(meta.size)})` : ''} …`);
    const digest = await download(`${base}/${meta.file}`, partial, opts, meta.size);
    if (digest !== meta.sha512) throw new Error('The downloaded AppImage does not match its SHA-512 checksum.');
    await fsp.chmod(partial, 0o755);
    push('Checksum OK');

    push('Unpacking the server from the new AppImage …');
    const extract = await execa(partial, ['--appimage-extract', 'resources/server/*'], {
      cwd: work,
      reject: false,
      timeout: 5 * 60_000,
      stdin: 'ignore',
      cancelSignal: opts.signal,
    });
    const bundle = path.join(work, 'squashfs-root', 'resources', 'server');
    const bin = path.join(bundle, 'bin', 'agentdeck-server');
    if (extract.exitCode !== 0 || !isFile(bin)) {
      throw new Error(`Could not unpack the new AppImage: ${String(extract.stderr || extract.stdout).trim().slice(-300) || `exit code ${extract.exitCode}`}`);
    }
    const bundled = (JSON.parse(await fsp.readFile(path.join(bundle, 'version.json'), 'utf8')) as { version?: string }).version;
    if (bundled !== release.version) throw new Error(`The new AppImage carries server ${bundled ?? '?'} instead of ${release.version}.`);

    await fsp.rename(partial, target);
    push(`Desktop app replaced with v${release.version}`);

    const status = await serviceStatus(bin);
    if (!status.installed || !status.managed) {
      push('The server does not run as the background service: it moves to the new version the next time the desktop app starts.');
      await fsp.rm(work, { recursive: true, force: true });
      return;
    }

    push('Installing the new server and restarting the service — the app reconnects in a moment …');
    await installDetached(bin, work, status.lan, opts.logFile);
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * `service install` in its own session, output into the log. It restarts the
 * service (and so ends this process) — on success this promise usually never
 * settles; it rejects when the install fails before that.
 */
function installDetached(bin: string, work: string, lan: boolean, logFile: string): Promise<void> {
  const fd = fs.openSync(logFile, 'a', 0o600);
  // The unpacked bundle goes away after the install copied it.
  const script = '"$0" service install "$@"; rc=$?; rm -rf "$AGENTDECK_UPDATE_WORK"; exit $rc';
  const child = spawn('sh', ['-c', script, bin, ...(lan ? ['--lan'] : []), '--json'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, AGENTDECK_UPDATE_WORK: work },
  });
  fs.closeSync(fd);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agentdeck-server service install failed (exit code ${code ?? 'signal'}) — details in update.log.`));
    });
  });
}
