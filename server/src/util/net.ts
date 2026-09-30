import os from 'node:os';

/**
 * True for loopback and LAN (private/link-local) addresses — used to restrict
 * pairing and bridge access to the local network.
 */
export function isLocalAddress(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  let addr = remoteAddress;
  // Node writes IPv4-mapped IPv6 as ::ffff:a.b.c.d
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  if (addr === '::1' || addr === 'localhost') return true;
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('10.')) return true;
  if (addr.startsWith('192.168.')) return true;
  if (addr.startsWith('169.254.')) return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // IPv6 ULA fc00::/7
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1]);
    if (Number.isInteger(second) && second >= 16 && second <= 31) return true;
  }
  // Compare against this host's own addresses (container/boundary cases).
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const entry of ifs ?? []) {
      if (entry.address === remoteAddress) return true;
    }
  }
  return false;
}

/** LAN IPv4 addresses of this machine (for the startup banner). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const entry of ifs ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}
