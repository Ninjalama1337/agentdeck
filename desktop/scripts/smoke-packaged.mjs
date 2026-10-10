// Headless smoke test of a PACKAGED build (release/linux-unpacked, or an extracted AppImage) with the
// server bundle it carries: packaged resource lookup, launcher, auto-pairing, the real web app.
//   node scripts/smoke-packaged.mjs [path/to/agentdeck]     (default: release/linux-unpacked/agentdeck)
// As root (CI containers) the Chromium sandbox cannot run: run with AGENTDECK_NO_SANDBOX=1.
// Message boxes cannot be answered here, so the close behaviour is preset to "background" (and the window is not closed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, freePort, healthy, root, sleep, until } from './smoke-lib.mjs';

const exe = path.resolve(process.argv[2] ?? path.join(root, 'release/linux-unpacked/agentdeck'));
if (!fs.existsSync(exe)) {
  console.error(`No packaged app at ${exe} — run npm run pack (or dist) first.`);
  process.exit(2);
}
const appDir = path.dirname(exe);
const port = await freePort();
const dataDir = path.join(os.tmpdir(), `agentdeck-smoke-packaged-data-${process.pid}`);
const h = await createHarness({
  port,
  tag: 'smoke-packaged',
  env: {
    AGENTDECK_DATA_DIR: dataDir,
    AGENTDECK_PORT: String(port),
    // What the AppImage runtime exports; makes the app treat its files as volatile (stage the server).
    ...(process.env.SMOKE_APPIMAGE_DIR ? { APPDIR: process.env.SMOKE_APPIMAGE_DIR } : {}),
  },
  // The deb's binary has no launcher: as root it needs the flag itself (the AppImage launcher takes the env switch).
  app: (debugPort, extraArgs) => ({
    file: exe,
    args: [...(process.env.AGENTDECK_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--remote-debugging-port=${debugPort}`, ...extraArgs],
  }),
});
const { check } = h;
fs.mkdirSync(h.files.userData, { recursive: true });
fs.writeFileSync(path.join(h.files.userData, 'settings.json'), JSON.stringify({ closeAction: 'background', lanAccess: false, launchAtLogin: false }));

try {
  const run = await h.launch();
  const page = await h.connectPage();
  await until(async () => (await page.evaluate("document.getElementById('root') && document.getElementById('root').children.length")) > 0, 60000, 'the web app to render');
  check('packaged app: the web app of the bundled server renders', true);
  check('bridge present', (await page.evaluate('typeof window.agentdeckDesktop')) === 'object');
  const servers = JSON.parse(await page.evaluate("localStorage.getItem('agentdeck:servers')"));
  check('auto-paired', Boolean(servers?.servers?.[0]?.token));
  const status = await page.evaluate('agentdeckDesktop.getServerStatus()');
  check('server started detached from the packaged bundle', status.mode === 'detached' && status.reachable, JSON.stringify(status));
  const marker = JSON.parse(fs.readFileSync(path.join(h.files.userData, 'detached.json'), 'utf8'));
  const volatile = Boolean(process.env.SMOKE_APPIMAGE_DIR);
  check(
    volatile ? 'volatile (AppImage-like) install: the server runs from a staged runtime copy, not from the app dir' : 'installed app: the server runs from the app dir',
    volatile ? marker.bin.includes('/agentdeck/runtime/') && !marker.bin.startsWith(appDir) : marker.bin.startsWith(appDir),
    marker.bin,
  );
  const serverEnv = fs.readFileSync(`/proc/${marker.pid}/environ`, 'utf8').split('\0');
  check('the server environment is free of AppImage / Electron variables', !serverEnv.some((e) => /^(APPDIR|APPIMAGE|ELECTRON_[A-Z_]+)=/.test(e)), serverEnv.filter((e) => /APPDIR|APPIMAGE|ELECTRON/.test(e)).join(' '));
  if (volatile) check('PATH of the server does not point into the app mount', !serverEnv.find((e) => e.startsWith('PATH='))?.includes(process.env.SMOKE_APPIMAGE_DIR));
  if (process.env.SMOKE_RUN_AS) {
    // Chromium's sandbox puts its renderers under a seccomp filter (Seccomp: 2). Renderers of this
    // run only — anything left over from an earlier run is ignored; a starting one gets a moment.
    const state = () => {
      const mine = fs
        .readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .filter((d) => {
          try {
            const environ = fs.readFileSync(`/proc/${d}/environ`, 'utf8');
            return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=renderer') && environ.includes(h.files.tmp);
          } catch {
            return false;
          }
        });
      const sandboxed = mine.filter((d) => /^Seccomp:\s+2$/m.test(fs.readFileSync(`/proc/${d}/status`, 'utf8')));
      return { total: mine.length, sandboxed: sandboxed.length };
    };
    const ok = await until(() => state().total > 0 && state().sandboxed === state().total, 8000, 'sandboxed renderers').then(() => true, () => false);
    check("the renderer runs inside Chromium's sandbox (seccomp filter) — preload, bridge and pairing work there", ok, JSON.stringify(state()));
  }
  // The packaged app has no test hooks, so the window is not closed here — the app is killed hard instead:
  // a server started by the app must survive even that.
  h.killApps();
  await run.exited;
  await sleep(500);
  check('the detached server survives the app being killed', await healthy(port));
} catch (err) {
  check('smoke test ran to completion', false, err instanceof Error ? err.stack : String(err));
  console.log(`--- output of the last app run:\n${h.lastOutput().slice(-3000)}`);
} finally {
  try {
    const pidFile = path.join(dataDir, 'server.pid');
    if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(h.finish());
