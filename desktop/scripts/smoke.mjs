// Headless smoke test of the real Electron app under xvfb, against a fake server CLI.
//   npm run smoke            (needs the Electron binary, xvfb-run, a built dist/)
// Drives the window through the DevTools protocol; native dialogs are answered by smoke-entry.cjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules/electron/dist/electron');
const fake = path.join(root, 'test/fixtures/fake-agentdeck-server.mjs');
const entry = path.join(root, 'scripts/smoke-entry.cjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 20000, label = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-smoke-'));
const port = await freePort();
const debugPort = await freePort();
const dataDir = path.join(tmp, 'data');
const userData = path.join(tmp, 'userdata');
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const dialogLog = path.join(tmp, 'dialogs.jsonl');
const answers = path.join(tmp, 'answers.json');
const calls = path.join(tmp, 'calls.log');
const cmdFile = path.join(tmp, 'cmd.json');
const boundsFile = path.join(tmp, 'bounds.json');
fs.writeFileSync(answers, '[]');

const baseEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_STATE_HOME: path.join(home, '.local/state'),
  AGENTDECK_SERVER_BIN: fake,
  AGENTDECK_DESKTOP_USER_DATA: userData,
  AGENTDECK_NO_UPDATE_CHECK: '1',
  FAKE_DATA_DIR: dataDir,
  FAKE_PORT: String(port),
  FAKE_VERSION: '9.9.9',
  FAKE_CALLS: calls,
  SMOKE_DIALOG_LOG: dialogLog,
  SMOKE_DIALOG_ANSWERS: answers,
  SMOKE_CMD_FILE: cmdFile,
  SMOKE_BOUNDS_FILE: boundsFile,
};
delete baseEnv.ELECTRON_RUN_AS_NODE;

const launched = [];
const outputs = [];
function launch(extraArgs = [], extraEnv = {}) {
  const child = spawn(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1600x1000x24', electron, entry, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, ...extraArgs],
    // own process group, so a leftover app (and its Xvfb) can be killed as a whole
    { cwd: root, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  launched.push(child);
  outputs.push(() => output);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, close: () => ws.close() };
}

function closeWindow() {
  fs.writeFileSync(cmdFile, JSON.stringify({ close: true }));
}

function readBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
  } catch {
    return null;
  }
}

async function connectPage() {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port}/`));
  }, 30000, 'the app page');
  const { send, close } = await cdp(target.webSocketDebuggerUrl);
  return {
    send,
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text + JSON.stringify(res.result.exceptionDetails.exception?.description));
      return res.result?.result?.value;
    },
    close,
    targetId: target.id,
  };
}

function dialogs() {
  try {
    return fs
      .readFileSync(dialogLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

try {
  // ------------------------------------------------------------------ run 1: first start
  console.log('--- run 1: first start (no systemd -> detached server, auto-pairing, bridge)');
  fs.writeFileSync(answers, JSON.stringify([]));
  const run1 = launch();
  const page = await connectPage();

  const probe = await until(async () => {
    const title = await page.evaluate('document.title');
    return title === 'bridge=yes' || title === 'bridge=no' ? page.evaluate('JSON.stringify(window.__probe)') : null;
  }, 30000, 'the fake server page to load');
  const p = JSON.parse(probe);
  check('window loads the server page from the fixed origin', (await page.evaluate('location.origin')) === `http://127.0.0.1:${port}`);
  check('preload bridge window.agentdeckDesktop exists before the page scripts run', p.bridge === true, probe);
  check('bridge reports platform linux', p.platform === 'linux', String(p.platform));
  const servers = p.servers ? JSON.parse(p.servers) : null;
  check(
    'device was auto-paired BEFORE the page read localStorage (token in agentdeck:servers)',
    servers?.servers?.[0]?.token === 'fake-token-1' && servers.servers[0].base === '' && servers.activeId === 'default',
    p.servers ?? 'null',
  );
  check('server name from the pairing response is stored', servers?.servers?.[0]?.name === 'fake-deck');
  check('pairing used the code file, which rotated afterwards', fs.readFileSync(path.join(dataDir, 'pairing-code.txt'), 'utf8').trim() !== '123456');
  check('no service offer dialog without systemd', !dialogs().some((d) => /Hintergrunddienst/.test(d.message ?? '')));
  check('server was started detached by the app', fs.existsSync(path.join(dataDir, 'server.pid')) && (await healthy(port)));
  check('detached marker recorded', fs.existsSync(path.join(userData, 'detached.json')));

  const status = await page.evaluate('agentdeckDesktop.getServerStatus()');
  check('getServerStatus: detached, reachable, controllable', status.mode === 'detached' && status.reachable && status.controllable && status.port === port && status.version === '9.9.9', JSON.stringify(status));
  const settings0 = await page.evaluate('agentdeckDesktop.getSettings()');
  check('getSettings returns the defaults', JSON.stringify(settings0) === JSON.stringify({ closeAction: 'ask', lanAccess: false, launchAtLogin: false }), JSON.stringify(settings0));
  const settings1 = await page.evaluate("agentdeckDesktop.setSettings({ launchAtLogin: true, bogus: 1 })");
  check('setSettings(launchAtLogin) writes the XDG autostart entry', settings1.launchAtLogin === true && fs.existsSync(path.join(home, '.config/autostart/agentdeck.desktop')));
  const entryText = fs.readFileSync(path.join(home, '.config/autostart/agentdeck.desktop'), 'utf8');
  check('autostart entry starts the app with --hidden', /^Exec=.*--hidden$/m.test(entryText), entryText);
  await page.evaluate("agentdeckDesktop.setSettings({ launchAtLogin: false })");
  check('launchAtLogin=false removes the entry', !fs.existsSync(path.join(home, '.config/autostart/agentdeck.desktop')));
  const failedAction = await page.evaluate("agentdeckDesktop.serviceAction('install').then(() => 'ok', (e) => e.message)");
  check('serviceAction(install) without systemd fails with a clean message', /systemd/.test(failedAction) && !/Error invoking/.test(failedAction), String(failedAction));
  const badAction = await page.evaluate("agentdeckDesktop.serviceAction('rm -rf').then(() => 'ok', (e) => e.message)");
  check('unknown service action is rejected', /Unknown action/.test(badAction), String(badAction));

  // status events reach the page
  await page.evaluate("window.__events = []; window.__off = agentdeckDesktop.onServerStatus((s) => window.__events.push(s.mode)); true");

  // navigation guard
  await page.evaluate("document.getElementById('ext').click()");
  await sleep(800);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  check('target=_blank link opens no new window', targets.filter((t) => t.type === 'page').length === 1);
  await page.evaluate("location.href = 'https://example.org/'").catch(() => undefined);
  await sleep(1000);
  const urlAfter = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page')?.url;
  check('navigation away from the server origin is blocked', urlAfter?.startsWith(`http://127.0.0.1:${port}/`), String(urlAfter));

  // unauthorized -> re-pair + reload
  const page2 = await connectPage();
  await page2.evaluate("localStorage.setItem('agentdeck:servers', JSON.stringify({servers:[{id:'default',name:'',base:'',token:null}],activeId:'default'})); window.dispatchEvent(new CustomEvent('agentdeck:unauthorized')); true");
  const repaired = await until(async () => {
    const pg = await connectPage();
    const v = await pg.evaluate('window.__probe && window.__probe.servers');
    pg.close();
    return v && JSON.parse(v).servers[0].token === 'fake-token-2' ? v : null;
  }, 15000, 're-pairing after agentdeck:unauthorized').catch(() => null);
  check('agentdeck:unauthorized triggers a fresh pairing and a reload (token 2)', Boolean(repaired));
  page2.close();

  // window state: resize through the protocol, then close via the dialog
  const livePage = await connectPage();
  fs.writeFileSync(cmdFile, JSON.stringify({ bounds: { x: 120, y: 90, width: 1111, height: 777 } }));
  await until(() => readBounds()?.bounds.width === 1111, 10000, 'the window to resize');
  await sleep(1200); // the state is saved debounced

  // close: dialog -> cancel (checkbox ticked: must not be remembered)
  fs.writeFileSync(answers, JSON.stringify([{ response: 2, checkboxChecked: true }]));
  fs.writeFileSync(dialogLog, '');
  closeWindow();
  const closeDialog = await until(() => dialogs().find((d) => /Dienst/.test(d.message ?? '')), 15000, 'the close dialog');
  check('close shows the dialog with 3 buttons in the plan\'s order', JSON.stringify(closeDialog.buttons) === JSON.stringify(['Im Hintergrund weiterlaufen', 'Dienst stoppen und beenden', 'Abbrechen']), JSON.stringify(closeDialog.buttons));
  check('dialog default is "keep running", has "Nicht mehr fragen"', closeDialog.defaultId === 0 && closeDialog.checkboxLabel === 'Nicht mehr fragen');
  check('dialog detail names running agent runs and terminals from the API (2 + 3)', /2 Agent-Läufe und 3 Terminals/.test(closeDialog.detail), closeDialog.detail);
  check('dialog detail says terminals keep running in tmux', /tmux/.test(closeDialog.detail));
  await sleep(1500);
  check('cancel keeps the app and window open', run1.child.exitCode === null && (await healthy(port)));
  const settingsAfterCancel = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  check('cancel with "Nicht mehr fragen" ticked does not change the setting', settingsAfterCancel.closeAction === 'ask', JSON.stringify(settingsAfterCancel));

  // single instance: a second launch exits and leaves the first running
  const second = launch();
  const secondExit = await Promise.race([second.exited, sleep(15000).then(() => null)]);
  check('second instance exits immediately (single-instance lock)', secondExit !== null && secondExit.code === 0, JSON.stringify(secondExit));
  check('first instance keeps running after the second launch', run1.child.exitCode === null);

  // close: keep running + remember
  fs.writeFileSync(answers, JSON.stringify([{ response: 0, checkboxChecked: true }]));
  fs.writeFileSync(dialogLog, '');
  closeWindow();
  const exit1 = await Promise.race([run1.exited, sleep(30000).then(() => null)]);
  check('"Im Hintergrund weiterlaufen" quits the app', exit1 !== null, run1.output().slice(-600));
  check('the server keeps running after the app quit', await healthy(port));
  const settingsAfterBg = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  check('"Nicht mehr fragen" stores the choice (background)', settingsAfterBg.closeAction === 'background', JSON.stringify(settingsAfterBg));
  const ws1 = JSON.parse(fs.readFileSync(path.join(userData, 'window-state.json'), 'utf8'));
  check('window state was saved with the resized size', ws1.width === 1111 && ws1.height === 777, JSON.stringify(ws1));

  // ------------------------------------------------------------------ run 2: restore
  console.log('--- run 2: restart (state restored, no dialog because closeAction=background)');
  fs.rmSync(boundsFile, { force: true });
  const run2 = launch();
  const pageB = await connectPage();
  await until(async () => (await pageB.evaluate('document.title')) === 'bridge=yes', 30000, 'page title of run 2');
  const pairedB = JSON.parse(await pageB.evaluate('window.__probe.servers'));
  check('second start keeps the login (profile is stable, no new pairing)', pairedB.servers[0].token === 'fake-token-2', JSON.stringify(pairedB));
  const statusB = await pageB.evaluate('agentdeckDesktop.getServerStatus()');
  check('server started by the previous run is still recognized as ours (detached)', statusB.mode === 'detached' && statusB.controllable, JSON.stringify(statusB));
  const winB = await until(() => readBounds(), 10000, 'window bounds of run 2');
  check('window size restored', winB.bounds.width === 1111 && winB.bounds.height === 777 && winB.visible, JSON.stringify(winB));
  check('window position restored', winB.bounds.x === 120 && winB.bounds.y === 90, JSON.stringify(winB));
  // closeAction=background: closes without a dialog
  fs.writeFileSync(dialogLog, '');
  closeWindow();
  const exit2 = await Promise.race([run2.exited, sleep(30000).then(() => null)]);
  check('closeAction=background quits without asking', exit2 !== null && !dialogs().some((d) => /Dienst/.test(d.message ?? '')), run2.output().slice(-400));
  check('server still running', await healthy(port));

  // ------------------------------------------------------------------ run 3: stop
  console.log('--- run 3: closeAction=stop stops the detached server');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ closeAction: 'stop', lanAccess: false, launchAtLogin: false }));
  const run3 = launch();
  const pageC = await connectPage();
  await until(async () => (await pageC.evaluate('document.title')) === 'bridge=yes', 30000, 'page title of run 3');
  closeWindow();
  const exit3 = await Promise.race([run3.exited, sleep(40000).then(() => null)]);
  check('closeAction=stop quits the app', exit3 !== null, run3.output().slice(-400));
  await sleep(500);
  check('the detached server was stopped (SIGTERM, pid file removed)', !(await healthy(port)) && !fs.existsSync(path.join(dataDir, 'server.pid')));
  check('detached marker removed', !fs.existsSync(path.join(userData, 'detached.json')));

  // ------------------------------------------------------------------ run 4: --hidden
  console.log('--- run 4: --hidden ensures the server, then exits');
  const run4 = launch(['--hidden']);
  const exit4 = await Promise.race([run4.exited, sleep(40000).then(() => null)]);
  check('--hidden exits by itself', exit4 !== null && exit4.code === 0, run4.output().slice(-400));
  check('--hidden left a running server behind', await healthy(port));
  // clean up that server
  const pid = Number(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf8').trim());
  process.kill(pid, 'SIGTERM');
  await until(async () => !(await healthy(port)), 10000, 'server stop').catch(() => undefined);

  // ------------------------------------------------------------------ run 5: port taken by a stranger
  console.log('--- run 5: foreign program on the port -> clear error, no other port');
  const stranger = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi')).listen(port, '127.0.0.1');
  await sleep(200);
  fs.writeFileSync(answers, JSON.stringify([{ response: 1, checkboxChecked: false }]));
  fs.writeFileSync(dialogLog, '');
  const run5 = launch();
  const exit5 = await Promise.race([run5.exited, sleep(40000).then(() => null)]);
  stranger.close();
  const portDialog = dialogs().find((d) => /ist belegt/.test(d.message ?? ''));
  check('port conflict shows a clear message with the port (and a retry/quit choice)', Boolean(portDialog) && portDialog.message.includes(String(port)), JSON.stringify(dialogs()));
  check('the app quits on "Beenden" instead of using another port', exit5 !== null);
} catch (err) {
  check('smoke test ran to completion', false, err instanceof Error ? err.stack : String(err));
  console.log(`--- output of the last app run:\n${outputs.at(-1)?.().slice(-3000)}`);
} finally {
  try {
    const pidFile = path.join(dataDir, 'server.pid');
    if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
  } catch {}
  for (const child of launched) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  if (!process.env.SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
