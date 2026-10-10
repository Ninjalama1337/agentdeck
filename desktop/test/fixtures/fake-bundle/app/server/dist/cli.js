#!/usr/bin/env node
// Stand-in for `agentdeck-server` (the real one is built by scripts/build-server-bundle.sh).
// Used by the unit tests (real exec path) and by scripts/smoke.mjs (the app under xvfb).
//
//   agentdeck-server                       -> the server (foreground), like the real CLI
//   agentdeck-server info --json           -> ServerCliInfo
//   agentdeck-server service status --json -> ServiceCliStatus (from FAKE_SERVICE)
//   agentdeck-server service <verb> …      -> recorded in FAKE_CALLS, exit 0
//
// Environment: FAKE_DATA_DIR (required), FAKE_PORT (required), FAKE_VERSION,
// FAKE_SERVICE (JSON, default: no systemd), FAKE_CALLS (file to append argv to),
// AGENTDECK_HOST (bind address, default 127.0.0.1), AGENTDECK_PORT (only recorded in bind.txt).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dataDir = process.env.FAKE_DATA_DIR;
const port = Number(process.env.FAKE_PORT);
const version = process.env.FAKE_VERSION || '9.9.9';
if (!dataDir || !port) {
  console.error('FAKE_DATA_DIR and FAKE_PORT are required');
  process.exit(2);
}
const pidFile = path.join(dataDir, 'server.pid');
const codeFile = path.join(dataDir, 'pairing-code.txt');
const args = process.argv.slice(2);

if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, `${args.join(' ')}\n`);

if (args[0] === 'info') {
  console.log(
    JSON.stringify({
      version,
      packaged: true,
      dataDir,
      configPath: path.join(dataDir, 'config.json'),
      host: process.env.AGENTDECK_HOST || '127.0.0.1',
      port,
      pairingCodeFile: codeFile,
      pidFile,
    }),
  );
} else if (args[0] === 'service') {
  if (args[1] === 'status') {
    const fallback = {
      systemd: false,
      installed: false,
      managed: false,
      enabled: false,
      active: false,
      unitPath: path.join(dataDir, 'agentdeck.service'),
      lan: false,
    };
    console.log(JSON.stringify(process.env.FAKE_SERVICE ? JSON.parse(process.env.FAKE_SERVICE) : fallback));
  }
} else if (args.length === 0) {
  serve();
} else {
  console.error(`unknown command: ${args.join(' ')}`);
  process.exit(2);
}

function serve() {
  fs.mkdirSync(dataDir, { recursive: true });
  let code = '123456';
  if (fs.existsSync(codeFile)) code = fs.readFileSync(codeFile, 'utf8').trim();
  else fs.writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
  // survives restarts of the fake, so token numbers keep counting
  const issuedFile = path.join(dataDir, 'issued.txt');
  let issued = fs.existsSync(issuedFile) ? Number(fs.readFileSync(issuedFile, 'utf8')) : 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authed = /^Bearer fake-token-\d+$/.test(req.headers.authorization || '');
    if (url.pathname === '/api/health') return json(200, { ok: true, name: 'agentdeck', version, agents: [] });
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        const current = fs.readFileSync(codeFile, 'utf8').trim();
        if (body.code !== current) return json(401, { error: { code: 'INVALID_CODE', message: 'Invalid pairing code.' } });
        fs.writeFileSync(codeFile, `${String(100000 + Math.floor(Math.random() * 899999))}\n`, { mode: 0o600 });
        issued += 1;
        fs.writeFileSync(issuedFile, String(issued));
        json(200, { token: `fake-token-${issued}`, server: { name: 'fake-deck', version, host: `127.0.0.1:${port}` } });
      });
      return;
    }
    if (url.pathname === '/api/sessions') {
      return authed
        ? json(200, [{ id: 's1', status: 'running' }, { id: 's2', status: 'idle' }, { id: 's3', status: 'queued' }])
        : json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
    }
    if (url.pathname === '/api/terminals') {
      return authed ? json(200, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]) : json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>fake</title></head><body><a id="ext" target="_blank" href="https://example.org/">ext</a>
<script>
  window.__probe = {
    bridge: Boolean(window.agentdeckDesktop),
    platform: window.agentdeckDesktop && window.agentdeckDesktop.platform,
    servers: localStorage.getItem('agentdeck:servers'),
  };
  document.title = 'bridge=' + (window.__probe.bridge ? 'yes' : 'no');
</script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const host = process.env.AGENTDECK_HOST || '127.0.0.1';
  server.listen(port, host, () => {
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    // what the app asked for, for the tests
    fs.writeFileSync(path.join(dataDir, 'bind.txt'), `${host}:${process.env.AGENTDECK_PORT ?? ''}\n`);
  });
  const stop = () => {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
