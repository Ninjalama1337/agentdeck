import { describe, expect, it } from 'vitest';
import { parseProcStat, parsePs, processTree, sampleProcesses, type ProcSample } from '../src/term/resources.js';

describe('parseProcStat', () => {
  it('reads pid, parent, ticks and memory, also with odd names', () => {
    const line = '4242 (tmux: server (1)) S 4000 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 1000 9000000 2560 18446744073709551615';
    expect(parseProcStat(line)).toEqual({ pid: 4242, ppid: 4000, name: 'tmux: server (1)', ticks: 200, rss: 2560 * 4096 });
    expect(parseProcStat('garbage')).toBeNull();
  });
});

describe('parsePs', () => {
  it('reads ps output and strips paths', () => {
    expect(parsePs('  12     1  3.5  2048 /usr/bin/node\n')).toEqual([{ pid: 12, ppid: 1, cpu: 3.5, rss: 2048 * 1024, name: 'node' }]);
  });
});

describe('processTree', () => {
  const p = (pid: number, ppid: number): ProcSample => ({ pid, ppid, name: `p${pid}`, cpu: 0, rss: 0 });
  it('collects the root and all descendants, nothing else', () => {
    const all = [p(1, 0), p(10, 1), p(11, 10), p(12, 11), p(20, 1), p(13, 10)];
    expect(processTree(10, all).map((x) => x.pid).sort()).toEqual([10, 11, 12, 13]);
  });
});

describe('sampleProcesses', () => {
  it('finds this test process', async () => {
    const all = await sampleProcesses();
    const me = all.find((s) => s.pid === process.pid);
    expect(me?.rss).toBeGreaterThan(0);
  });
});
