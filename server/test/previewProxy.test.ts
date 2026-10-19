import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localPath, PreviewProxy, signPreviewToken, verifyPreviewToken } from '../src/preview/proxy.js';
import { DESIGN_BRIDGE_PATH, DESIGN_BRIDGE_TAG, DESIGN_COOKIE, injectBridge } from '../src/preview/designBridge.js';
import { parseLsof, parseProcNetTcp } from '../src/preview/ports.js';

const SECRET = 'ab'.repeat(32);
const log = { info: () => undefined, warn: () => undefined };

describe('preview tokens', () => {
  it('carry the port and expire', () => {
    const t = signPreviewToken(SECRET, 5173, 0);
    expect(verifyPreviewToken(SECRET, t, 1000)).toBe(5173);
    expect(verifyPreviewToken(SECRET, t, 13 * 3600 * 1000)).toBeNull();
    expect(verifyPreviewToken('cd'.repeat(32), t, 1000)).toBeNull();
    expect(verifyPreviewToken(SECRET, `${t}x`, 1000)).toBeNull();
  });
  it('only redirect within the origin', () => {
    expect(localPath('/app?x=1')).toBe('/app?x=1');
    expect(localPath('//evil.example')).toBe('/');
    expect(localPath('https://evil.example')).toBe('/');
    expect(localPath(null)).toBe('/');
  });
});

describe('port parsing', () => {
  it('reads listening sockets from /proc/net/tcp', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1',
      '   1: 0100007F:1436 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1',
    ].join('\n');
    expect([...parseProcNetTcp(text, false)]).toEqual([['4242', { address: '127.0.0.1', port: 5173 }]]);
  });
  it('reads lsof output for the given processes', () => {
    expect(parseLsof('p10\nn*:3000\nn[::1]:3000\np11\nn127.0.0.1:9\n', new Set([10]))).toEqual([{ pid: 10, port: 3000, address: '0.0.0.0' }]);
  });
});

describe('PreviewProxy', () => {
  let target: http.Server;
  let proxy: PreviewProxy;
  let targetPort = 0;
  const seen: { host?: string; cookie?: string } = {};
  const upgraded: import('node:stream').Duplex[] = [];

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      seen.host = req.headers.host;
      seen.cookie = req.headers.cookie;
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h1>hi</h1></body></html>');
        return;
      }
      res.end(`hello ${req.url}`);
    });
    target.on('upgrade', (_req, socket) => {
      upgraded.push(socket);
      socket.on('error', () => undefined);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(d)); // echo
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    targetPort = (target.address() as net.AddressInfo).port;
    proxy = new PreviewProxy({ secretHex: SECRET, host: '127.0.0.1', port: 0, log });
    await proxy.start();
  });
  afterAll(async () => {
    await proxy.stop();
    for (const s of upgraded) s.destroy();
    target.closeAllConnections();
    await new Promise<void>((r) => target.close(() => r()));
  });

  const get = (path: string, cookie?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.port, path, headers: cookie ? { cookie } : {} }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  it('refuses requests without the cookie', async () => {
    expect((await get('/')).status).toBe(401);
  });

  it('sets the cookie from a signed link and forwards with the target host', async () => {
    const token = signPreviewToken(SECRET, targetPort);
    const entry = await get(`/__agentdeck_preview?t=${encodeURIComponent(token)}&path=/app`);
    expect(entry.status).toBe(302);
    expect(entry.headers.location).toBe('/app');
    const cookie = String(entry.headers['set-cookie']![0]).split(';')[0]!;
    const res = await get('/@vite/client', `${cookie}; other=1`);
    expect(res.body).toBe('hello /@vite/client');
    expect(seen.host).toBe(`localhost:${targetPort}`);
    expect(seen.cookie).toBe('other=1');
  });

  it('injects the design bridge only for a design-mode session', async () => {
    const token = signPreviewToken(SECRET, targetPort);
    const plain = await get(`/__agentdeck_preview?t=${encodeURIComponent(token)}&path=/page`);
    const plainCookies = plain.headers['set-cookie']!.map((c) => String(c));
    expect(plainCookies.some((c) => c.startsWith(`${DESIGN_COOKIE}=1`))).toBe(false);
    const plainCookie = plainCookies[0]!.split(';')[0]!;
    const untouched = await get('/page', plainCookie);
    expect(untouched.body).toContain('<h1>hi</h1>');
    expect(untouched.body).not.toContain(DESIGN_BRIDGE_TAG);

    const design = await get(`/__agentdeck_preview?t=${encodeURIComponent(token)}&path=/page&design=1`);
    const cookies = design.headers['set-cookie']!.map((c) => String(c).split(';')[0]);
    expect(cookies.some((c) => c.startsWith('agentdeck_design='))).toBe(true);
    const res = await get('/page', cookies.join('; '));
    expect(res.body).toContain(DESIGN_BRIDGE_TAG);
    expect(res.body.indexOf(DESIGN_BRIDGE_TAG)).toBeLessThan(res.body.indexOf('</body>'));
    // Plain text responses are forwarded unchanged.
    const json = await get('/data.json', cookies.join('; '));
    expect(json.body).toBe('hello /data.json');
  });

  it('clears the design flag when a plain link is opened', async () => {
    const token = signPreviewToken(SECRET, targetPort);
    const design = await get(`/__agentdeck_preview?t=${encodeURIComponent(token)}&path=/page&design=1`);
    const designCookies = design.headers['set-cookie']!.map((c) => String(c));
    expect(designCookies.some((c) => c.startsWith(`${DESIGN_COOKIE}=1;`) && /Max-Age=\d+/.test(c))).toBe(true);

    const plain = await get(`/__agentdeck_preview?t=${encodeURIComponent(token)}&path=/page`);
    const plainCookies = plain.headers['set-cookie']!.map((c) => String(c));
    expect(plainCookies.some((c) => c.startsWith(`${DESIGN_COOKIE}=;`) && /Max-Age=0/.test(c))).toBe(true);
    expect(plainCookies.some((c) => c.startsWith('agentdeck_preview=') && /Max-Age=\d+/.test(c))).toBe(true);
  });

  it('serves the bridge script to a preview session only', async () => {
    expect((await get(DESIGN_BRIDGE_PATH)).status).toBe(401);
    const token = signPreviewToken(SECRET, targetPort);
    const script = await get(DESIGN_BRIDGE_PATH, `agentdeck_preview=${token}`);
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain('agentdeck-design');
  });

  it('tunnels WebSocket upgrades', async () => {
    const token = signPreviewToken(SECRET, targetPort);
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => {
        s.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: agentdeck_preview=${token}\r\n\r\n`);
      });
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping');
        if (buf.includes('ping')) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on('error', reject);
    });
    expect(reply).toContain('101 Switching Protocols');
    expect(reply).toContain('ping');
  });
});

describe('design bridge injection', () => {
  it('inserts the tag before the closing body and keeps the markup', () => {
    const html = '<!doctype html><html><body><h1>hi</h1></body></html>';
    const out = injectBridge(html);
    expect(out).toBe(`<!doctype html><html><body><h1>hi</h1>${DESIGN_BRIDGE_TAG}</body></html>`);
  });

  it('appends when there is no body tag to anchor on', () => {
    expect(injectBridge('<h1>fragment</h1>')).toBe(`<h1>fragment</h1>${DESIGN_BRIDGE_TAG}`);
  });

  it('anchors on the last body close tag', () => {
    expect(injectBridge('<body>a</body><!-- x -->')).toBe(`<body>a${DESIGN_BRIDGE_TAG}</body><!-- x -->`);
  });
});

describe('listeningPorts', () => {
  it('finds a port this process listens on', async () => {
    const { listeningPorts } = await import('../src/preview/ports.js');
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '0.0.0.0', () => r()));
    const port = (s.address() as net.AddressInfo).port;
    const found = await listeningPorts(new Set([process.pid]));
    await new Promise<void>((r) => s.close(() => r()));
    expect(found.some((p) => p.port === port)).toBe(true);
  });
});
