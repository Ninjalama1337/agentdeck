/**
 * Client-IP resolution behind a trusted proxy.
 *
 * When a Cloudflare Tunnel is active, cloudflared proxies requests to the
 * local server: the direct socket peer is 127.0.0.1/::1 and the real client
 * IP arrives in `x-forwarded-for`. Only a loopback peer may be trusted — a
 * spoofed XFF header from a LAN client must be ignored so per-IP rate
 * limiting and pairing buckets cannot be poisoned.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { isLocalAddress } from './net.js';

export interface ClientIpRequestLike {
  socket: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
}

/** Strips the IPv4-mapped-IPv6 prefix Node uses for dual-stack sockets. */
export function normalizeIp(addr: string | undefined | null): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  const a = normalizeIp(addr);
  return a === '::1' || a === 'localhost' || a.startsWith('127.');
}

/** First entry of a comma-separated x-forwarded-for header (single or array form). */
export function firstForwardedFor(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  return first ? first : undefined;
}

/**
 * Best-effort client IP for rate limiting / attempt buckets:
 * XFF is honored ONLY when the direct socket peer is loopback (trusted local
 * proxy such as cloudflared); otherwise the socket address is used verbatim.
 */
export function clientIp(req: ClientIpRequestLike): string {
  const peer = req.socket?.remoteAddress;
  if (isLoopbackAddress(peer)) {
    const forwarded = firstForwardedFor(req.headers?.['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return normalizeIp(peer) || 'unknown';
}

/** Headers a proxy uses to name the client it forwards for (one address each). */
const SINGLE_CLIENT_HEADERS = ['cf-connecting-ip', 'cf-connecting-ipv6', 'true-client-ip', 'x-real-ip'] as const;

/** `1.2.3.4:5678` → `1.2.3.4`, `[::1]:80` → `::1`; anything else unchanged. */
function stripPort(addr: string): string {
  const bracketed = addr.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1] as string;
  const v4 = addr.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? (v4[1] as string) : addr;
}

/**
 * Every client address a proxy claims in the request headers
 * (x-forwarded-for chain, Forwarded `for=`, Cloudflare/nginx single-IP headers).
 * Empty when the request carries no forwarding headers at all.
 */
export function forwardedAddresses(headers: IncomingHttpHeaders | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  const values = (name: string): string[] => {
    const raw = headers[name];
    return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  };
  for (const line of values('x-forwarded-for')) {
    for (const part of line.split(',')) out.push(part.trim());
  }
  for (const line of values('forwarded')) {
    for (const m of line.matchAll(/for=\s*"?([^;,"\s]+)/gi)) out.push(m[1] as string);
  }
  for (const name of SINGLE_CLIENT_HEADERS) {
    for (const line of values(name)) out.push(line.trim());
  }
  return out.map((addr) => normalizeIp(stripPort(addr)));
}

/**
 * True only when the request demonstrably comes from the LAN or localhost:
 * the socket peer is local AND every address named in forwarding headers is
 * local too. A tunnel or reverse proxy on this machine (cloudflared, Caddy)
 * connects from 127.0.0.1 but names the real client in those headers — a
 * client on the internet cannot remove what the proxy appends, so one public
 * (or unparseable) entry is enough to refuse.
 */
export function isLanRequest(req: ClientIpRequestLike): boolean {
  if (!isLocalAddress(req.socket?.remoteAddress)) return false;
  return forwardedAddresses(req.headers).every((addr) => isLocalAddress(addr));
}
