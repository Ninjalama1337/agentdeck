/**
 * AgentDeck desktop shell: a window on the AgentDeck server. It holds no state
 * of its own — the server (service, detached, or started elsewhere) does.
 * All decisions live in ./core (Electron-free, unit-tested); this file wires
 * them to Electron.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, Menu, session } from 'electron';
import { CH } from './channels';
import { fetchActivity } from './core/activity';
import { Autostart, autostartTarget, HIDDEN_FLAG } from './core/autostart';
import { createCli, resolveServerBin, type ResolvedServerBin } from './core/cli';
import { runCloseFlow, runExplicitQuit, type CloseFlowDeps } from './core/closeFlow';
import { ServerController } from './core/controller';
import { DetachedServer } from './core/detached';
import { childEnv } from './core/env';
import { nodeExec } from './core/exec';
import { nodeFs } from './core/fs';
import { createHealthProbe, type FetchLike } from './core/health';
import { createPairingCoordinator, deviceName, pairWithLocalServer } from './core/pairing';
import { desktopPaths, xdgPaths } from './core/paths';
import { systemProcessProbe } from './core/pidfile';
import { createRestartLimiter } from './core/restartLimit';
import { isVolatilePath, stageRuntime } from './core/runtimeStage';
import { toPublicStatus } from './core/serverStatus';
import { SettingsStore, StateStore } from './core/settings';
import { SettingsService } from './core/settingsService';
import { statusPageUrl } from './core/statusPage';
import { localToken, SERVERS_KEY } from './core/storagePairing';
import { TEXTS } from './core/texts';
import { isPermissionAllowed } from './core/urlPolicy';
import * as dialogs from './dialogs';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { checkForUpdate } from './updates';
import { createMainWindow, PARTITION } from './window';

const HIDDEN = process.argv.includes(HIDDEN_FLAG);
const DEVTOOLS = process.env.AGENTDECK_DEVTOOLS === '1';
const STATUS_POLL_MS = 5000;

// Where things live — fixed before anything else so the browser profile
// (localStorage, keyed by origin) is the same on every start.
const home = os.homedir();
const paths = desktopPaths(xdgPaths(process.env, home), process.env);
app.setPath('userData', paths.userData);

// Chromium's sandbox stays on. The only way off is an explicit switch.
if (process.env.AGENTDECK_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');

function createLogger(file: string): (message: string) => void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or no state dir — logging stays best effort */
  }
  return (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    process.stderr.write(line);
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* ignore */
    }
  };
}

const log = createLogger(paths.desktopLog);
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${String(reason)}`));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nodeFetch: FetchLike = (url, init) => fetch(url, init);

if (!app.requestSingleInstanceLock()) {
  // Another instance runs; it gets `second-instance` and shows its window.
  app.quit();
} else {
  void main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  log(`AgentDeck Desktop ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'development'})${HIDDEN ? ', hidden' : ''}`);

  const settingsStore = new SettingsStore(nodeFs, paths.settings);
  const stateStore = new StateStore(nodeFs, paths.state);
  await Promise.all([settingsStore.load(), stateStore.load()]);

  let win: BrowserWindow | null = null;
  let keeper: { saveNow(): Promise<void> } | null = null;
  let quitting = false;
  let wantWindow = !HIDDEN;
  // False while a hidden (login) start still ensures the server; a second launch then waits for it.
  let hiddenBootDone = true;
  let poller: NodeJS.Timeout | null = null;

  // ---- the CLI and the server it drives
  let bin: ResolvedServerBin;
  try {
    bin = await resolveServerBin({
      env: process.env,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      desktopDir: path.join(__dirname, '..'),
      exists: nodeFs.exists,
    });
  } catch (err) {
    log(String(err));
    await dialogs.showError(null, TEXTS.serverBinMissing, err instanceof Error ? err.message : String(err));
    app.exit(1);
    return;
  }
  const env = childEnv(process.env);
  const cli = createCli({ bin: bin.bin, exec: nodeExec, env });
  log(`server cli: ${bin.bin} (${bin.source})`);

  const detached = new DetachedServer({
    fs: nodeFs,
    markerFile: paths.detachedMarker,
    logFile: paths.serverLog,
    spawn: (file, args, options) => spawn(file, args, options),
    openLog: (file) => fs.openSync(file, 'a', 0o600),
    closeFd: (fd) => fs.closeSync(fd),
    probe: systemProcessProbe,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep,
    now: Date.now,
  });

  const controller = new ServerController({
    cli,
    cliSource: bin.source,
    probe: createHealthProbe({ fetch: nodeFetch }),
    detached,
    settings: settingsStore,
    state: stateStore,
    env,
    // A detached server must not run from the AppImage mount: it disappears with the app.
    async detachedBin(info) {
      if (!isVolatilePath(cli.bin, process.env)) return cli.bin;
      return stageRuntime({
        fs: nodeFs,
        bundleRoot: path.resolve(path.dirname(cli.bin), '..'),
        version: info.version,
        runtimeDir: paths.runtimeDir,
        pid: process.pid,
      });
    },
    offerService: () => dialogs.offerService(win),
    log,
    sleep,
    now: Date.now,
    serverLogFile: paths.serverLog,
  });

  let origin: string;
  try {
    origin = await controller.origin();
  } catch (err) {
    log(`cannot read the server info: ${String(err)}`);
    await dialogs.showError(null, TEXTS.startFailed, err instanceof Error ? err.message : String(err));
    app.exit(1);
    return;
  }
  log(`server origin: ${origin}`);

  // ---- pairing: the shell logs this device in to its own server
  const coordinator = createPairingCoordinator({
    now: Date.now,
    pair: async () => {
      const info = await controller.info();
      return pairWithLocalServer({
        baseUrl: origin,
        codeFile: info.pairingCodeFile,
        name: deviceName(),
        readFile: (file) => fsp.readFile(file, 'utf8'),
        fetch: (url, init) => fetch(url, init),
      });
    },
  });

  // ---- settings, autostart
  const autostart = new Autostart(nodeFs, paths.autostartFile, () => ({
    execPath: autostartTarget(process.env, process.execPath),
    args: app.isPackaged ? [] : [app.getAppPath()],
  }));
  const settings = new SettingsService({
    store: settingsStore,
    autostart,
    server: {
      serviceLan() {
        const service = controller.last()?.service;
        return service?.systemd && service.installed && service.managed ? service.lan : null;
      },
      applyLanAccess: (lan) => controller.applyLanAccess(lan),
    },
  });
  // The entry holds the app's path — fix only that line, so a moved AppImage keeps working and the desktop's own on/off switch stays.
  await autostart.healExec().catch((e) => log(String(e)));

  // ---- closing and quitting
  async function windowToken(): Promise<string | null> {
    const wc = win?.webContents;
    if (!wc || wc.isDestroyed() || !wc.getURL().startsWith(origin)) return null;
    try {
      const raw: unknown = await Promise.race([
        wc.executeJavaScript(`localStorage.getItem(${JSON.stringify(SERVERS_KEY)})`),
        sleep(1000).then(() => null),
      ]);
      return localToken(typeof raw === 'string' ? raw : null, origin);
    } catch {
      return null;
    }
  }

  async function finalQuit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    if (poller) clearInterval(poller);
    stopWaiting();
    try {
      await keeper?.saveNow();
      // Make sure localStorage (route, drafts, login) reaches the disk before the process ends.
      const ses = session.fromPartition(PARTITION);
      ses.flushStorageData();
      await ses.cookies.flushStore();
      await sleep(200);
    } catch (err) {
      log(`flush before quit failed: ${String(err)}`);
    }
    app.quit();
  }

  const flow: CloseFlowDeps = {
    async context() {
      // A server that is busy right now (but was fine) counts with its last known state.
      const state = await controller.stateForDecision();
      return {
        closeAction: settingsStore.get().closeAction,
        mode: state?.mode ?? 'stopped',
        controllable: state?.controllable ?? false,
        lan: state?.lan ?? false,
      };
    },
    async activity() {
      // The login goes to the AgentDeck server only — never to another program on the port.
      if ((await controller.identify()) !== 'agentdeck') return null;
      return fetchActivity({ baseUrl: origin, token: (await windowToken()) ?? coordinator.lastToken(), fetch: nodeFetch });
    },
    showDialog: (model) => dialogs.askClose(win, model),
    remember: async (action) => {
      await settingsStore.update({ closeAction: action });
    },
    stopServer: () => controller.stopForQuit(),
    stopFailed: (message) => dialogs.stopFailed(win, message),
    quit: finalQuit,
  };

  let closeInFlight = false;
  function requestClose(): void {
    if (quitting || closeInFlight) return;
    closeInFlight = true;
    runCloseFlow(flow)
      .catch((err: unknown) => log(`close flow failed: ${String(err)}`))
      .finally(() => {
        closeInFlight = false;
      });
  }

  registerIpc({
    origin,
    identify: () => controller.identify(),
    appVersion: app.getVersion(),
    platform: process.platform,
    getStatus: () => controller.refresh(),
    serviceAction: (action) => controller.serviceAction(action),
    getSettings: () => settings.get(),
    setSettings: (patch) => settings.set(patch),
    pair: () => coordinator.request(),
    quit: async ({ stopService }) => {
      await runExplicitQuit(flow, { stopService });
    },
    log,
  });

  // ---- session: fixed profile, narrow permissions
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin, origin));

  Menu.setApplicationMenu(
    buildMenu({
      devTools: DEVTOOLS,
      onQuit: requestClose,
      onReload: () => win?.webContents.reload(),
    }),
  );

  // ---- window
  let waitTimer: NodeJS.Timeout | null = null;
  function stopWaiting(): void {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
  }

  /**
   * Shows the status page and loads the app as soon as an AgentDeck server answers. The page
   * cannot navigate by itself — it would follow a foreign program on the port just as well.
   */
  function waitForServer(title: string, detail?: string): void {
    const target = win;
    if (!target || target.isDestroyed()) return;
    void target.loadURL(statusPageUrl({ origin, title, ...(detail ? { detail } : {}) }));
    if (waitTimer) return;
    waitTimer = setInterval(() => {
      void controller
        .refresh()
        .then(async (state) => {
          if (!state.reachable || quitting) return;
          stopWaiting();
          if (win && !win.isDestroyed()) await win.loadURL(`${origin}/`);
        })
        .catch(() => undefined);
    }, 1500);
  }

  async function loadApp(): Promise<void> {
    for (;;) {
      const result = await controller.ensureRunning({ interactive: true });
      if (result.ok) break;
      log(`server start failed (${result.kind}): ${result.message}`);
      const port = result.state?.port ?? 0;
      const text =
        result.kind === 'port-busy'
          ? TEXTS.portBusy(port)
          : result.kind === 'unresponsive'
            ? TEXTS.portUnresponsive(port)
            : { message: TEXTS.startFailed, detail: result.message };
      if (!(await dialogs.startFailed(win, text.message, text.detail))) {
        await finalQuit();
        return;
      }
    }
    stopWaiting();
    await win?.loadURL(`${origin}/`);
  }

  async function openWindow(): Promise<void> {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    const created = await createMainWindow({
      fs: nodeFs,
      stateFile: paths.windowState,
      preload: path.join(__dirname, 'preload.js'),
      icon: path.join(__dirname, 'icon.png'),
      origin,
      devTools: DEVTOOLS,
      log,
    });
    win = created.win;
    keeper = created.keeper;
    const current = win;
    current.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      requestClose();
    });
    current.on('closed', () => {
      win = null;
      stopWaiting();
    });
    // The server went away under a loaded page: wait for it instead of showing Chromium's error page.
    current.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !url.startsWith(origin)) return;
      waitForServer('Der AgentDeck-Server ist nicht erreichbar', 'Die Verbindung wird erneut versucht, sobald er antwortet.');
    });
    // A crashed renderer comes back by itself (the web app restores its route) — but not in a loop.
    const reloads = createRestartLimiter(3, 60_000);
    current.webContents.on('render-process-gone', (_event, details) => {
      log(`renderer gone: ${details.reason}`);
      if (details.reason === 'clean-exit' || quitting) return;
      if (reloads.allow(Date.now())) {
        setTimeout(() => !current.isDestroyed() && current.reload(), 1000);
      } else {
        void current.loadURL(statusPageUrl({ origin, title: TEXTS.renderCrash.title, detail: TEXTS.renderCrash.detail }));
      }
    });
    // Back in front: look at the server again right away.
    const lookAgain = (): void => void controller.refresh().catch(() => undefined);
    current.on('focus', lookAgain);
    current.on('restore', lookAgain);
    current.on('show', lookAgain);
    void current.loadURL(statusPageUrl({ origin, title: 'AgentDeck startet …' }));
    await loadApp().catch((err: unknown) => log(`cannot load the app: ${String(err)}`));

    if (!poller) {
      // The health probe is cheap; the bundle CLI and systemctl behind a full refresh are not — and a
      // window nobody looks at needs no live status.
      poller = setInterval(() => {
        if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
        void controller.refresh().catch(() => undefined);
      }, STATUS_POLL_MS);
    }
    if (app.isPackaged && process.env.AGENTDECK_NO_UPDATE_CHECK !== '1') {
      setTimeout(
        () => void checkForUpdate({ currentVersion: app.getVersion(), state: stateStore, window: () => win, log }),
        20_000,
      ).unref();
    }
  }

  controller.onChange((state) => {
    if (win && !win.isDestroyed()) win.webContents.send(CH.serverStatus, toPublicStatus(state));
  });

  app.on('second-instance', (_event, argv) => {
    if (quitting) return;
    if (argv.includes(HIDDEN_FLAG)) return;
    wantWindow = true;
    if (!hiddenBootDone) return; // the hidden start opens the window when it is done
    void openWindow();
  });
  app.on('window-all-closed', () => app.quit());
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void finalQuit());

  // ---- go
  if (HIDDEN) {
    // Login autostart: make sure the server runs, then leave — no window, no process left over.
    hiddenBootDone = false;
    const result = await controller.ensureRunning({ interactive: false });
    log(result.ok ? `server is up (${result.state.mode})` : `server start failed: ${result.message}`);
    hiddenBootDone = true;
    if (!wantWindow) {
      await finalQuit();
      return;
    }
  }
  await openWindow();
}
