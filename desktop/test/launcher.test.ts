import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'linux', 'agentdeck-launcher.sh');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { env }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

describe('AppImage launcher (build/linux/agentdeck-launcher.sh)', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-launcher-'));
    // agentdeck.bin stands in for the Electron binary: it prints its arguments.
    await writeFile(path.join(dir, 'agentdeck.bin'), '#!/bin/sh\necho "BIN $*"\n');
    await chmod(path.join(dir, 'agentdeck.bin'), 0o755);
    await copyFile(launcher, path.join(dir, 'agentdeck'));
    await chmod(path.join(dir, 'agentdeck'), 0o755);
    // A fake zenity that records the call.
    await writeFile(path.join(dir, 'zenity'), `#!/bin/sh\necho "$@" > "${dir}/zenity.log"\n`);
    await chmod(path.join(dir, 'zenity'), 0o755);
    // The launcher skips the probe for root (Chromium refuses root on its own) — pose as a normal user.
    await writeFile(path.join(dir, 'id'), '#!/bin/sh\necho 1000\n');
    await chmod(path.join(dir, 'id'), 0o755);
    env = { PATH: `${dir}:/usr/bin:/bin`, APPIMAGE: '/home/me/AgentDeck.AppImage' };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The probe is replaceable so the tests do not depend on the kernel / AppArmor of the machine.
  const launch = (args: string[], extra: Record<string, string>) => run(path.join(dir, 'agentdeck'), args, { ...env, ...extra });
  const asUser = { AGENTDECK_SANDBOX_PROBE: 'true' };

  it('starts the app unchanged when a sandbox is possible', async () => {
    const r = await launch(['--hidden', 'x'], asUser);
    expect(r.stdout.trim()).toBe('BIN --hidden x');
  });

  it('drops a --no-sandbox that AppRun (or a hand) added', async () => {
    const r = await launch(['--no-sandbox', '--hidden', '--no-sandbox'], asUser);
    expect(r.stdout.trim()).toBe('BIN --hidden');
  });

  it('keeps arguments with spaces intact', async () => {
    const r = await launch(['a b', '--no-sandbox', 'c'], asUser);
    expect(r.stdout.trim()).toBe('BIN a b c');
  });

  it('stops with an explanation instead of silently disabling the sandbox', async () => {
    const r = await launch([], { AGENTDECK_SANDBOX_PROBE: 'false' });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('BIN');
    expect(r.stderr).toContain('Chromium-Sandbox');
    expect(r.stderr).toContain('profile agentdeck-appimage "/home/me/AgentDeck.AppImage"');
    expect(r.stderr).toContain('AGENTDECK_NO_SANDBOX=1');
    expect(await readFile(path.join(dir, 'zenity.log'), 'utf8')).toContain('Chromium-Sandbox');
  });

  it('does not pop up a window for the login autostart', async () => {
    const r = await launch(['--hidden'], { AGENTDECK_SANDBOX_PROBE: 'false' });
    expect(r.code).toBe(1);
    await expect(readFile(path.join(dir, 'zenity.log'), 'utf8')).rejects.toThrow();
  });

  it('turns the sandbox off only on the explicit switch', async () => {
    const r = await launch(['--hidden'], { AGENTDECK_SANDBOX_PROBE: 'false', AGENTDECK_NO_SANDBOX: '1' });
    expect(r.stdout.trim()).toBe('BIN --no-sandbox --hidden');
    expect(r.stderr).toContain('WITHOUT the Chromium sandbox');
  });

  it('does not probe as root (Chromium gives its own message there)', async () => {
    await writeFile(path.join(dir, 'id'), '#!/bin/sh\necho 0\n');
    const r = await launch(['--hidden'], { AGENTDECK_SANDBOX_PROBE: 'false' });
    expect(r.stdout.trim()).toBe('BIN --hidden');
  });

  it('resolves its own directory through a symlink', async () => {
    const linkDir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-launcher-link-'));
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(path.join(dir, 'agentdeck'), path.join(linkDir, 'agentdeck'));
      const r = await run(path.join(linkDir, 'agentdeck'), ['go'], { ...env, ...asUser });
      expect(r.stdout.trim()).toBe('BIN go');
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});
