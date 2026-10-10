// Headless smoke test of the Electron app against the REAL server bundle (dist-bundle/agentdeck-server,
// built by scripts/build-server-bundle.sh) — real CLI, real /api/pair, real web app in the window.
//   npm run build && npm run smoke:real
// systemd is not touched: HOME is a throw-away dir, so a machine without a usable user manager
// takes the detached path; with one, the "set up the service?" dialog is answered with "no".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, freePort, healthy, root, sleep, until } from './smoke-lib.mjs';

const bin = process.env.AGENTDECK_SERVER_BIN || path.resolve(root, '../dist-bundle/agentdeck-server/bin/agentdeck-server');
if (!fs.existsSync(bin)) {
  console.error(`No server bundle at ${bin} — run scripts/build-server-bundle.sh first.`);
  process.exit(2);
}
const port = await freePort();
const dataDir = path.join(os.tmpdir(), `agentdeck-smoke-real-data-${process.pid}`);
const h = await createHarness({
  serverBin: bin,
  port,
  tag: 'smoke-real',
  env: { AGENTDECK_DATA_DIR: dataDir, AGENTDECK_PORT: String(port) },
});
const { check } = h;

try {
  h.answer([{ response: 1, checkboxChecked: false }]); // "no" if a service offer shows up
  const run = await h.launch();
  const page = await h.connectPage();

  await until(async () => (await page.evaluate("document.getElementById('root') && document.getElementById('root').children.length")) > 0, 60000, 'the web app to render');
  check('the real web app renders in the window', true);
  check('bridge present', (await page.evaluate('typeof window.agentdeckDesktop')) === 'object');

  const servers = JSON.parse(await page.evaluate("localStorage.getItem('agentdeck:servers')"));
  const token = servers?.servers?.[0]?.token;
  check('auto-paired: a real device token is stored', typeof token === 'string' && token.split('.').length === 3, JSON.stringify(servers));
  const api = await page.evaluate(
    `fetch('/api/server', { headers: { authorization: 'Bearer ${token}' } }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
  );
  check('the token works against the real API (GET /api/server)', api.status === 200 && api.body.version === '0.1.0', JSON.stringify(api));
  const devices = await page.evaluate(
    `fetch('/api/devices', { headers: { authorization: 'Bearer ${token}' } }).then((r) => r.json())`,
  );
  check('the server lists this device as "<hostname> (Desktop)"', devices.some((d) => d.name === `${os.hostname()} (Desktop)`.slice(-64)), JSON.stringify(devices));

  const status = await page.evaluate('agentdeckDesktop.getServerStatus()');
  check('status: detached, reachable, controllable, real version', status.mode === 'detached' && status.reachable && status.controllable && status.version === '0.1.0', JSON.stringify(status));
  check('the pid file of the real server exists and matches the marker', (() => {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf8'));
    return JSON.parse(fs.readFileSync(path.join(h.files.userData, 'detached.json'), 'utf8')).pid === pid;
  })());
  check('pairing code file is private (0600)', (fs.statSync(path.join(dataDir, 'pairing-code.txt')).mode & 0o077) === 0);

  h.clearDialogs();
  h.answer([{ response: 1, checkboxChecked: false }]); // stop and quit
  h.closeWindow();
  const dlg = await until(() => h.dialogs().find((d) => /Dienst/.test(d.message ?? '')), 15000, 'the close dialog');
  check('close dialog shows the real activity (nothing running)', /Gerade läuft kein Agent und kein Terminal/.test(dlg.detail), dlg.detail);
  const exit = await Promise.race([run.exited, sleep(40000).then(() => null)]);
  check('"Dienst stoppen und beenden" quits the app', exit !== null, h.lastOutput().slice(-500));
  await sleep(800);
  check('the real server stopped cleanly (pid file removed, port closed)', !fs.existsSync(path.join(dataDir, 'server.pid')) && !(await healthy(port)));
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
