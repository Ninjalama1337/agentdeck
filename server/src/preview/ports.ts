/**
 * Which TCP ports the processes of a terminal listen on (a dev server an agent
 * started, `npm run dev` in a shell) — after Orca's ports view.
 *
 * Linux: /proc/net/tcp{,6} lists listening sockets by inode; /proc/<pid>/fd
 * maps inodes to processes. macOS: `lsof`.
 */
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ListeningPort {
  pid: number;
  port: number;
  /** "127.0.0.1", "0.0.0.0", "::" … */
  address: string;
}

function hexIPv4(hex: string): string {
  // Little-endian per 32-bit word in /proc/net/tcp.
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

/** Listening sockets of /proc/net/tcp or tcp6: inode → address and port. */
export function parseProcNetTcp(text: string, v6: boolean): Map<string, { address: string; port: number }> {
  const out = new Map<string, { address: string; port: number }>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue; // 0A = LISTEN
    const [addrHex, portHex] = (cols[1] ?? '').split(':');
    if (!addrHex || !portHex) continue;
    const address = v6 ? (/^0+$/.test(addrHex) ? '::' : addrHex === '00000000000000000000000001000000' ? '::1' : 'ipv6') : hexIPv4(addrHex);
    out.set(cols[9]!, { address, port: parseInt(portHex, 16) });
  }
  return out;
}

async function linuxPorts(pids: Set<number>): Promise<ListeningPort[]> {
  const sockets = new Map<string, { address: string; port: number }>();
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    try {
      for (const [inode, s] of parseProcNetTcp(await fsp.readFile(file, 'utf8'), v6)) sockets.set(inode, s);
    } catch {
      /* no IPv6 */
    }
  }
  if (sockets.size === 0) return [];
  const out: ListeningPort[] = [];
  const seen = new Set<string>();
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await fsp.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      const s = m ? sockets.get(m[1]!) : undefined;
      // One entry per port and process (IPv4 and IPv6 sockets of one server collapse).
      if (s && !seen.has(`${pid}:${s.port}`)) {
        seen.add(`${pid}:${s.port}`);
        out.push({ pid, ...s });
      }
    }
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → ports (macOS and other Unixes). */
export function parseLsof(out: string, pids: Set<number>): ListeningPort[] {
  const list: ListeningPort[] = [];
  const seen = new Set<string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pids.has(pid)) {
      const m = /^n(.*):(\d+)$/.exec(line);
      if (!m) continue;
      const port = Number(m[2]);
      if (seen.has(`${pid}:${port}`)) continue;
      seen.add(`${pid}:${port}`);
      list.push({ pid, port, address: m[1] === '*' ? '0.0.0.0' : m[1]!.replace(/^\[|\]$/g, '') });
    }
  }
  return list;
}

export async function listeningPorts(pids: Set<number>): Promise<ListeningPort[]> {
  if (pids.size === 0) return [];
  if (process.platform === 'linux') return linuxPorts(pids);
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { maxBuffer: 8 * 1024 * 1024 });
    return parseLsof(stdout, pids);
  } catch {
    return [];
  }
}
