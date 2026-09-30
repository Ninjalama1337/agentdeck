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
