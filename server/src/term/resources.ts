/**
 * CPU and memory per terminal (after Orca's resource monitor): every process
 * below a terminal's shell — the agent CLI, its tools, dev servers it started.
 *
 * Linux reads /proc twice, half a second apart, for the CPU load right now
 * (`ps` there averages over a process's whole life); elsewhere `ps` does.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLK_TCK = 100;
const PAGE = 4096;
const SAMPLE_MS = 500;

export interface ProcSample {
  pid: number;
  ppid: number;
  name: string;
  /** CPU in percent of one core. */
  cpu: number;
  /** Resident memory in bytes. */
  rss: number;
}

interface StatLine {
  pid: number;
  ppid: number;
  name: string;
  ticks: number;
  rss: number;
}

/** One /proc/<pid>/stat line; the name sits in parentheses and may contain anything. */
export function parseProcStat(line: string): StatLine | null {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const rest = line.slice(close + 2).split(' ');
  // rest[0] = state, [1] = ppid, [11] = utime, [12] = stime, [21] = rss (pages)
  const ppid = Number(rest[1]);
  const ticks = Number(rest[11]) + Number(rest[12]);
  const rss = Number(rest[21]) * PAGE;
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  return { pid, ppid, name: line.slice(open + 1, close), ticks: Number.isFinite(ticks) ? ticks : 0, rss: Number.isFinite(rss) ? rss : 0 };
}

async function readProc(): Promise<Map<number, StatLine>> {
  const out = new Map<number, StatLine>();
  const entries = await fsp.readdir('/proc');
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        try {
          const s = parseProcStat(await fsp.readFile(`/proc/${e}/stat`, 'utf8'));
          if (s) out.set(s.pid, s);
        } catch {
          /* gone meanwhile */
        }
      }),
  );
  return out;
}

/** `ps -A -o pid=,ppid=,pcpu=,rss=,comm=` → samples (rss in KiB there). */
export function parsePs(out: string): ProcSample[] {
  const list: ProcSample[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[5]!.trim();
    list.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, name: name.slice(name.lastIndexOf('/') + 1) });
  }
  return list;
}

export async function sampleProcesses(): Promise<ProcSample[]> {
  if (process.platform === 'linux') {
    const a = await readProc();
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const b = await readProc();
    return [...b.values()].map((s) => {
      const before = a.get(s.pid);
      const delta = before ? Math.max(0, s.ticks - before.ticks) : 0;
      return { pid: s.pid, ppid: s.ppid, name: s.name, rss: s.rss, cpu: (delta / CLK_TCK / (SAMPLE_MS / 1000)) * 100 };
    });
  }
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss=,comm='], { maxBuffer: 8 * 1024 * 1024 });
  return parsePs(stdout);
}

/** The root and everything below it. */
export function processTree(root: number, all: ProcSample[]): ProcSample[] {
  const children = new Map<number, ProcSample[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: ProcSample[] = [];
  const self = all.find((p) => p.pid === root);
  if (self) out.push(self);
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

export function systemLoad(): { load: number; cpus: number; memTotal: number; memFree: number } {
  return { load: os.loadavg()[0] ?? 0, cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem() };
}
