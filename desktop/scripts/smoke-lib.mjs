// Shared harness of the headless smoke tests (smoke.mjs, smoke-real.mjs): launches the real
// Electron app under xvfb with a throw-away HOME and drives its window over the DevTools protocol.
// Native message boxes are answered by smoke-entry.cjs (nothing of this ships in the package).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules/electron/dist/electron');
const entry = path.join(root, 'scripts/smoke-entry.cjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function until(fn, timeoutMs = 20000, label = 'condition') {
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

export async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
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

/**
 * @param {{ serverBin: string, port: number, env?: Record<string, string>, tag?: string }} options
 *   `env` is added to every app launch (for the server CLI: its data dir, version …).
 */
export async function createHarness(options) {
  const { serverBin, port } = options;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-${options.tag ?? 'smoke'}-`));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const files = {
    tmp,
    home,
    userData: path.join(tmp, 'userdata'),
    dialogLog: path.join(tmp, 'dialogs.jsonl'),
    answers: path.join(tmp, 'answers.json'),
    cmd: path.join(tmp, 'cmd.json'),
    bounds: path.join(tmp, 'bounds.json'),
  };
  fs.writeFileSync(files.answers, '[]');

  const baseEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    AGENTDECK_SERVER_BIN: serverBin,
    AGENTDECK_DESKTOP_USER_DATA: files.userData,
    AGENTDECK_NO_UPDATE_CHECK: '1',
    SMOKE_DIALOG_LOG: files.dialogLog,
    SMOKE_DIALOG_ANSWERS: files.answers,
    SMOKE_CMD_FILE: files.cmd,
    SMOKE_BOUNDS_FILE: files.bounds,
    ...(options.env ?? {}),
  };
  delete baseEnv.ELECTRON_RUN_AS_NODE;

  const results = [];
  const launched = [];
  const outputs = [];
  let debugPort = 0;

  const h = {
    files,
    port,
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
    },
    /** Starts the app; returns { child, exited, output }. */
    async launch(extraArgs = [], extraEnv = {}) {
      debugPort = await freePort(); // a fresh DevTools port per run: the previous one may sit in TIME_WAIT
      const child = spawn(
        'xvfb-run',
        ['-a', '-s', '-screen 0 1600x1000x24', electron, entry, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, ...extraArgs],
        // own process group, so a leftover app (and its Xvfb) can be killed as a whole
        { cwd: root, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      launched.push(child);
      let output = '';
      outputs.push(() => output);
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      return { child, exited, output: () => output };
    },
    async targets() {
      return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).filter((t) => t.type === 'page');
    },
    /** The page of the app (served from the server's origin). */
    async connectPage() {
      const target = await until(async () => (await h.targets()).find((t) => t.url.startsWith(`http://127.0.0.1:${port}/`)), 40000, 'the app page');
      const { send, close } = await cdp(target.webSocketDebuggerUrl);
      return {
        send,
        async evaluate(expression) {
          const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (res.result?.exceptionDetails) {
            throw new Error(res.result.exceptionDetails.text + JSON.stringify(res.result.exceptionDetails.exception?.description));
          }
          return res.result?.result?.value;
        },
        close,
        targetId: target.id,
      };
    },
    /** Same event as the title bar's close button. */
    closeWindow() {
      fs.writeFileSync(files.cmd, JSON.stringify({ close: true }));
    },
    setBounds(bounds) {
      fs.writeFileSync(files.cmd, JSON.stringify({ bounds }));
    },
    readBounds() {
      try {
        return JSON.parse(fs.readFileSync(files.bounds, 'utf8'));
      } catch {
        return null;
      }
    },
    /** Queue answers for the next message boxes: [{ response, checkboxChecked }]. */
    answer(list) {
      fs.writeFileSync(files.answers, JSON.stringify(list));
    },
    clearDialogs() {
      fs.writeFileSync(files.dialogLog, '');
    },
    dialogs() {
      try {
        return fs
          .readFileSync(files.dialogLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    lastOutput: () => outputs.at(-1)?.() ?? '',
    /** Kills leftovers, removes the temp dir, prints the summary; returns the exit code. */
    finish() {
      for (const child of launched) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      if (!process.env.SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
      else console.log(`kept ${tmp}`);
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      return failed.length ? 1 : 0;
    },
  };
  return h;
}
