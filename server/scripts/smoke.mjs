#!/usr/bin/env node
/**
 * AgentDeck smoke test: boots the built server (dist/index.js) against a
 * scratch data dir on an ephemeral port and exercises the core API surface:
 * health, pairing, agents, project + session creation, attachment upload,
 * file listing and signed-token download. No real agent runs are started.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(serverRoot, 'dist', 'index.js');
const die = (message) => {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) die(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  die('server did not become healthy in time');
}

async function waitFor(fn, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`${what} not satisfied in time`);
}

async function main() {
  if (!fs.existsSync(distEntry)) {
    die(`missing ${distEntry} — run \`npm run -w server build\` first`);
  }
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-smoke-'));
  const dataDir = path.join(tmpRoot, 'data');
  const projectsRoot = path.join(tmpRoot, 'projects');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [distEntry], {
    env: {
      ...process.env,
      AGENTDECK_PORT: String(port),
      AGENTDECK_DATA_DIR: dataDir,
      AGENTDECK_PROJECTS_ROOT: projectsRoot,
      AGENTDECK_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  child.stdout.on('data', (c) => tail.push(String(c)));
  child.stderr.on('data', (c) => tail.push(String(c)));

  try {
    // 1. health
    const health = await waitForHealth(`${base}/api/health`, child);
    if (health.ok !== true || health.name !== 'agentdeck') {
      die(`unexpected health payload: ${JSON.stringify(health)}`);
    }
    console.log(`health: ok (v${health.version}, agents: ${health.agents.map((a) => `${a.id}=${a.available}`).join(' ')})`);

    // 2. claude must be detected on this machine
    const agentsRes = await fetch(`${base}/api/agents`);
    if (agentsRes.status !== 401) die('unauthenticated /api/agents must 401');
    await waitFor(async () => {
      const res = await fetch(`${base}/api/health`);
      const body = await res.json();
      return body.agents.some((a) => a.id === 'claude' && a.available === true);
    }, 'claude agent detection');
    console.log('agents: claude detected');

    // 3. pairing (code from disk)
    const codeFile = path.join(dataDir, 'pairing-code.txt');
    const code = (await waitFor(async () => {
      try {
        const content = (await fsp.readFile(codeFile, 'utf8')).trim();
        return /^\d{6}$/.test(content) ? content : null;
      } catch {
        return null;
      }
    }, 'pairing code file'));
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'smoke-runner' }),
    });
    if (!pairRes.ok) die(`pair failed: ${pairRes.status} ${await pairRes.text()}`);
    const { token } = await pairRes.json();
    if (!token) die('pair returned no token');
    const rotated = (await fsp.readFile(codeFile, 'utf8')).trim();
    if (rotated === code) die('pairing code was not rotated');
    console.log('pair: ok (token issued, code rotated)');

    const auth = { authorization: `Bearer ${token}` };

    // 4. agents list
    const agentsList = await (await fetch(`${base}/api/agents`, { headers: auth })).json();
    if (!Array.isArray(agentsList) || agentsList.length < 1) die('agents list empty');
    console.log(`agents: ${agentsList.map((a) => a.id).join(', ')}`);

    // 5. project + session
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'smoke-project', initGit: true }),
      })
    ).json();
    if (!project.id) die(`project create failed: ${JSON.stringify(project)}`);
    const session = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, agentId: 'claude' }),
      })
    ).json();
    if (!session.id) die(`session create failed: ${JSON.stringify(session)}`);
    console.log(`project+session: ok (${project.id}, ${session.id})`);

    // 6. upload a 1x1 png (unauthenticated → must 401)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const anonUpload = await fetch(`${base}/api/projects/${project.id}/files/upload?sessionId=${session.id}`, {
      method: 'POST',
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
        return fd;
      })(),
    });
    if (anonUpload.status !== 401) die('unauthenticated upload must 401');

    const upload = await fetch(`${base}/api/projects/${project.id}/files/upload?sessionId=${session.id}`, {
      method: 'POST',
      headers: auth,
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
        return fd;
      })(),
    });
    if (!upload.ok) die(`upload failed: ${upload.status} ${await upload.text()}`);
    const attachment = await upload.json();
    if (!attachment.url || attachment.kind !== 'image') die(`bad attachment payload: ${JSON.stringify(attachment)}`);

    // 7. signed download (no auth header — download-manager style)
    const download = await fetch(`${base}${attachment.url}`);
    if (download.status !== 200) die(`signed download failed: ${download.status}`);
    if ((download.headers.get('content-type') || '') !== 'image/png') die('wrong content-type on download');
    const body = Buffer.from(await download.arrayBuffer());
    if (!body.equals(png)) die('downloaded bytes differ from uploaded bytes');
    console.log('upload+signed download: ok');

    // 8. file listing (authed) — dotfiles hidden by default
    await fsp.writeFile(path.join(project.path, '.hidden'), 'x');
    await fsp.writeFile(path.join(project.path, 'README.md'), '# smoke');
    const files = await (await fetch(`${base}/api/projects/${project.id}/files`, { headers: auth })).json();
    const names = files.map((f) => f.name);
    if (!names.includes('README.md') || names.includes('.hidden')) {
      die(`unexpected listing: ${JSON.stringify(names)}`);
    }
    const allFiles = await (
      await fetch(`${base}/api/projects/${project.id}/files?all=1`, { headers: auth })
    ).json();
    if (!allFiles.some((f) => f.name === '.hidden')) die('all=1 must include dotfiles');
    console.log(`files: ok (${allFiles.length} entries incl. dotfiles)`);

    // 9. no active turn was sent — session stays idle; interrupt is a no-op 204
    const interrupt = await fetch(`${base}/api/sessions/${session.id}/interrupt`, {
      method: 'POST',
      headers: auth,
    });
    if (interrupt.status !== 204) die('interrupt should be 204');
    console.log('interrupt: ok (204)');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(path.dirname(dataDir), { recursive: true, force: true }).catch(() => undefined);
  }

  console.log('SMOKE OK');
}

main().catch((err) => {
  die(err?.stack || String(err));
});
