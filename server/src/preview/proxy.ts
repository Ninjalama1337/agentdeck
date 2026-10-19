/**
 * Preview proxy (after Orca's port forwarding): a dev server an agent started
 * on this machine (`localhost:5173`) opens on the phone or in another browser.
 *
 * It listens on its own port (AgentDeck's + 1) and forwards everything —
 * absolute asset paths, HMR WebSockets — to one local port, so dev servers
 * work unchanged; a path prefix on the main port would break their absolute
 * URLs. Access needs a signed link from the authed API: it sets a cookie
 * naming the target port, and only requests carrying that cookie get through.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { DESIGN_BRIDGE_PATH, DESIGN_COOKIE, designBridgeScript, injectBridge } from './designBridge.js';

export const PREVIEW_TOKEN_TTL_SECONDS = 12 * 3600;
const COOKIE = 'agentdeck_preview';
const ENTRY = '/__agentdeck_preview';

function hmac(secretHex: string, data: string): string {
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`preview:${data}`).digest('base64url');
}

export function signPreviewToken(secretHex: string, port: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ port, exp: Math.floor(now / 1000) + PREVIEW_TOKEN_TTL_SECONDS })).toString('base64url');
  return `${body}.${hmac(secretHex, body)}`;
}

/** The target port of a valid, unexpired token, or null. */
export function verifyPreviewToken(secretHex: string, token: string | undefined, now = Date.now()): number | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(secretHex, body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { port, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { port?: unknown; exp?: unknown };
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof exp !== 'number' || exp * 1000 < now) return null;
    return port;
  } catch {
    return null;
  }
}

/** Where the entry link continues: a path on this origin, never another site. */
export function localPath(path: string | null): string {
  return path && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
}

function cookieToken(header: string | undefined): string | undefined {
  return cookieValue(header, COOKIE);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Request headers for the target: its own Host (dev servers check it), our cookie removed. */
function forwardHeaders(headers: http.IncomingHttpHeaders, port: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers, host: `localhost:${port}` };
  const cookies = (headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${COOKIE}=`));
  if (cookies.length) out.cookie = cookies.join('; ');
  else delete out.cookie;
  // The page asks its dev server, not a foreign origin.
  if (out.origin) out.origin = `http://localhost:${port}`;
  return out;
}

export interface PreviewProxyOptions {
  secretHex: string;
  host: string;
  port: number;
  log: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
}

export class PreviewProxy {
  private server: http.Server | null = null;
  private listening = false;
  /** Upgraded (WebSocket) connections — the HTTP server no longer tracks them. */
  private readonly tunnels = new Set<Duplex>();

  constructor(private readonly opts: PreviewProxyOptions) {}

  /** The port it listens on (the asked-for one, or what the OS picked for 0). */
  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  get running(): boolean {
    return this.listening;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise<void>((resolve) => {
      server.once('error', (err) => {
        // Port taken: previews are off, the rest of AgentDeck is unaffected.
        this.opts.log.warn({ err: (err as Error).message, port: this.opts.port }, 'preview proxy could not listen');
        resolve();
      });
      server.listen(this.opts.port, this.opts.host, () => {
        this.listening = true;
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.listening = false;
    for (const t of this.tunnels) t.destroy();
    this.tunnels.clear();
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://preview');
    if (url.pathname === ENTRY) {
      const token = url.searchParams.get('t') ?? undefined;
      const port = verifyPreviewToken(this.opts.secretHex, token);
      if (port === null) return this.deny(res);
      const cookies = [`${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}`];
      // Design Mode: the session is flagged so the proxy injects the picker into
      // the HTML it serves (drop the flag by opening a plain preview link).
      if (url.searchParams.get('design') === '1') {
        cookies.push(`${DESIGN_COOKIE}=1; SameSite=Lax; Path=/; Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}`);
      } else {
        cookies.push(`${DESIGN_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`);
      }
      res.writeHead(302, {
        'set-cookie': cookies,
        location: localPath(url.searchParams.get('path')),
      });
      res.end();
      return;
    }
    const cookie = req.headers.cookie;
    if (url.pathname === DESIGN_BRIDGE_PATH) {
      if (verifyPreviewToken(this.opts.secretHex, cookieToken(cookie)) === null) return this.deny(res);
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(designBridgeScript());
      return;
    }
    const port = verifyPreviewToken(this.opts.secretHex, cookieToken(cookie));
    if (port === null) return this.deny(res);
    const design = cookieValue(cookie, DESIGN_COOKIE) === '1';
    const headers = forwardHeaders(req.headers, port);
    // The bridge is injected into the HTML, which needs the body uncompressed.
    if (design) headers['accept-encoding'] = 'identity';
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
      (up) => {
        const type = String(up.headers['content-type'] ?? '');
        const html = design && /text\/html/i.test(type) && !up.headers['content-encoding'];
        if (!html) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (chunk: Buffer) => chunks.push(chunk));
        up.on('end', () => {
          const body = injectBridge(Buffer.concat(chunks).toString('utf8'));
          const out = { ...up.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          res.writeHead(up.statusCode ?? 502, { ...out, 'content-length': Buffer.byteLength(body) });
          res.end(body);
        });
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Nothing answers on port ${port} — is the dev server still running?`);
    });
    req.pipe(upstream);
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = verifyPreviewToken(this.opts.secretHex, cookieToken(req.headers.cookie));
    if (port === null) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      const headers = forwardHeaders(req.headers, port);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) lines.push(`${k}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.tunnels.add(socket);
    this.tunnels.add(upstream);
    const close = () => {
      upstream.destroy();
      socket.destroy();
      this.tunnels.delete(socket);
      this.tunnels.delete(upstream);
    };
    for (const end of [upstream, socket]) {
      end.on('error', close);
      end.on('close', close);
    }
  }

  private deny(res: http.ServerResponse): void {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2em;background:#0d0f14;color:#e6e9f0">' +
      '<h2>AgentDeck preview</h2><p>Open this preview from AgentDeck (Code tab → port chip). The link there is signed and valid for 12 hours.</p></body>');
  }
}
