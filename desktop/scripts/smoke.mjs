// Headless smoke test of the real Electron app under xvfb, against a fake server CLI.
//   npm run build && npm run smoke       (needs the Electron binary and xvfb-run)
// Covers: bridge + auto-pairing before the page runs, detached start, close dialog, window state,
// single instance, stop on close, --hidden, port conflict. For the real server bundle see smoke-real.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHarness, freePort, healthy, root, sleep, until } from './smoke-lib.mjs';

const fake = path.join(root, 'test/fixtures/fake-bundle/bin/agentdeck-server');
const port = await freePort();
const dataDir = path.join(os.tmpdir(), `agentdeck-smoke-data-${process.pid}`);
const h = await createHarness({
  serverBin: fake,
  port,
  env: {
    FAKE_DATA_DIR: dataDir,
    FAKE_PORT: String(port),
    FAKE_VERSION: '9.9.9',
  },
});
/** A program that is not AgentDeck on the server's port; it records everything it is asked. */
function startStranger(listenPort) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ? 'Bearer' : undefined });
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'not-agentdeck' }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end("<!doctype html><title>foreign:</title><script>document.title = 'foreign:' + typeof window.agentdeckDesktop;</script>");
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () =>
      resolve({
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** The fake server again, started by hand (not by the app). */
function startFake(dataDirectory, listenPort) {
  return spawn(fake, [], {
    stdio: 'ignore',
    env: { ...process.env, FAKE_DATA_DIR: dataDirectory, FAKE_PORT: String(listenPort), FAKE_VERSION: '9.9.9' },
  });
}

async function stopFake(dataDirectory) {
  const pid = Number(fs.readFileSync(path.join(dataDirectory, 'server.pid'), 'utf8').trim());
  process.kill(pid, 'SIGTERM');
}

const { check, launch, connectPage, closeWindow, readBounds, dialogs, answer, clearDialogs } = h;
const { home, userData } = h.files;

try {
  // ------------------------------------------------------------------ run 1: first start
  console.log('--- run 1: first start (no systemd -> detached server, auto-pairing, bridge)');
  answer([]);
  const run1 = await launch();
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
  check('detached server was started with bind address and port set explicitly', fs.readFileSync(path.join(dataDir, 'bind.txt'), 'utf8').trim() === `127.0.0.1:${port}`);
  const stopped = await page.evaluate("agentdeckDesktop.serviceAction('stop')");
  check('serviceAction(stop) stops the detached server', stopped.mode === 'stopped' && !(await healthy(port)), JSON.stringify(stopped));
  const restarted = await page.evaluate("agentdeckDesktop.serviceAction('start')");
  check('serviceAction(start) without a unit starts it detached again', restarted.mode === 'detached' && restarted.reachable, JSON.stringify(restarted));
  const events = await page.evaluate('window.__events');
  check('onServerStatus delivered the changes (stopped, then detached)', events.includes('stopped') && events.at(-1) === 'detached', JSON.stringify(events));
  await page.evaluate("agentdeckDesktop.setSettings({ lanAccess: true })");
  check('lanAccess=true restarts the detached server on all interfaces', fs.readFileSync(path.join(dataDir, 'bind.txt'), 'utf8').trim() === `0.0.0.0:${port}` && (await healthy(port)));
  const lanSettings = await page.evaluate('agentdeckDesktop.getSettings()');
  check('getSettings reports lanAccess', lanSettings.lanAccess === true);
  await page.evaluate("agentdeckDesktop.setSettings({ lanAccess: false })");
  check('lanAccess=false binds to loopback again', fs.readFileSync(path.join(dataDir, 'bind.txt'), 'utf8').trim() === `127.0.0.1:${port}`);

  // navigation guard
  await page.evaluate("document.getElementById('ext').click()");
  await sleep(800);
  const targets = await h.targets();
  check('target=_blank link opens no new window', targets.length === 1);
  await page.evaluate("location.href = 'https://example.org/'").catch(() => undefined);
  await sleep(1000);
  const urlAfter = (await h.targets()).find((t) => t.type === 'page')?.url;
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
  h.setBounds({ x: 120, y: 90, width: 1111, height: 777 });
  await until(() => readBounds()?.bounds.width === 1111, 10000, 'the window to resize');
  await sleep(1200); // the state is saved debounced

  // close: dialog -> cancel (checkbox ticked: must not be remembered)
  answer([{ response: 2, checkboxChecked: true }]);
  clearDialogs();
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
  const second = await launch();
  const secondExit = await Promise.race([second.exited, sleep(15000).then(() => null)]);
  check('second instance exits immediately (single-instance lock)', secondExit !== null && secondExit.code === 0, JSON.stringify(secondExit));
  check('first instance keeps running after the second launch', run1.child.exitCode === null);

  // close: keep running + remember
  answer([{ response: 0, checkboxChecked: true }]);
  clearDialogs();
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
  fs.rmSync(h.files.bounds, { force: true });
  const run2 = await launch();
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
  clearDialogs();
  closeWindow();
  const exit2 = await Promise.race([run2.exited, sleep(30000).then(() => null)]);
  check('closeAction=background quits without asking', exit2 !== null && !dialogs().some((d) => /Dienst/.test(d.message ?? '')), run2.output().slice(-400));
  check('server still running', await healthy(port));

  // ------------------------------------------------------------------ run 3: stop
  console.log('--- run 3: closeAction=stop stops the detached server');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ closeAction: 'stop', lanAccess: false, launchAtLogin: false }));
  const run3 = await launch();
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
  const run4 = await launch(['--hidden']);
  const exit4 = await Promise.race([run4.exited, sleep(40000).then(() => null)]);
  check('--hidden exits by itself', exit4 !== null && exit4.code === 0, run4.output().slice(-400));
  check('--hidden left a running server behind', await healthy(port));
  // clean up that server
  const pid = Number(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf8').trim());
  process.kill(pid, 'SIGTERM');
  await until(async () => !(await healthy(port)), 10000, 'server stop').catch(() => undefined);

  // ------------------------------------------------------------------ run 5: port taken by a stranger
  console.log('--- run 5: foreign program on the port -> clear error, no other port, nothing handed to it');
  const stranger1 = await startStranger(port);
  answer([{ response: 1, checkboxChecked: false }]);
  clearDialogs();
  const run5 = await launch();
  const exit5 = await Promise.race([run5.exited, sleep(40000).then(() => null)]);
  const portDialog = dialogs().find((d) => /ist belegt/.test(d.message ?? ''));
  check('port conflict shows a clear message with the port (and a retry/quit choice)', Boolean(portDialog) && portDialog.message.includes(String(port)), JSON.stringify(dialogs()));
  check('the app quits on "Beenden" instead of using another port', exit5 !== null);
  check(
    'the stranger was only asked for /api/health: no page load, no pairing code',
    stranger1.requests.every((r) => r.url === '/api/health') && stranger1.requests.length > 0,
    JSON.stringify(stranger1.requests),
  );
  await stranger1.close();

  // ------------------------------------------------------------------ run 6: a stranger takes the port under a running window
  console.log('--- run 6: a foreign program replaces the server -> no bridge, no pairing code, no navigation');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ closeAction: 'background', lanAccess: false, launchAtLogin: false }));
  const run6 = await launch();
  const page6 = await connectPage();
  await until(async () => (await page6.evaluate('document.title')) === 'bridge=yes', 30000, 'page title of run 6');
  page6.close();
  await stopFake(dataDir); // the real server goes away …
  await until(async () => !(await healthy(port)), 10000, 'server stop');
  const stranger2 = await startStranger(port); // … and a stranger takes its port
  h.reloadWindow(); // "Neu laden": the window loads whatever answers there
  const foreignPage = await connectPage();
  await until(async () => /^foreign:(undefined|object)$/.test(await foreignPage.evaluate('document.title')), 20000, 'the stranger\'s page');
  check('a foreign page gets no window.agentdeckDesktop', (await foreignPage.evaluate('typeof window.agentdeckDesktop')) === 'undefined');
  await sleep(1500);
  check('the pairing code was not sent to the stranger (no POST /api/pair)', !stranger2.requests.some((r) => r.method === 'POST'), JSON.stringify(stranger2.requests));
  check('the stranger got no login token either', !JSON.stringify(stranger2.requests).includes('Bearer'));
  foreignPage.close();
  await stranger2.close();

  // The window shows the status page while nothing answers; a stranger appearing then must not pull it along.
  h.reloadWindow();
  await until(async () => (await h.targets()).some((t) => t.url.startsWith('data:text/html')), 15000, 'the status page');
  check('with nothing on the port the window shows the status page', (await h.targets()).some((t) => t.url.startsWith('data:text/html')));
  const stranger3 = await startStranger(port);
  await sleep(5000);
  const during = (await h.targets()).map((t) => t.url.slice(0, 20));
  check('the status page does not follow a stranger that answers /api/health', during.every((u) => u.startsWith('data:')) && !stranger3.requests.some((r) => r.url === '/'), JSON.stringify({ during, requests: stranger3.requests }));
  await stranger3.close();

  // … but it loads the app as soon as the real server is back.
  const back = startFake(dataDir, port);
  await until(async () => (await h.targets()).some((t) => t.url.startsWith(`http://127.0.0.1:${port}/`)), 20000, 'the app to load again');
  const again = await connectPage();
  await until(async () => (await again.evaluate('document.title')) === 'bridge=yes', 15000, 'bridge after the server is back');
  check('the app loads by itself when the AgentDeck server answers again (bridge present)', (await again.evaluate('typeof window.agentdeckDesktop')) === 'object');
  again.close();
  back.kill('SIGTERM');
  h.killApps();
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
