import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../src/term/manager.js';
import type { Logger } from '../src/logging.js';

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

function waitsFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition not met in time'));
      }
    }, 25);
  });
}

describe('TerminalManager (real PTY)', () => {
  /**
   * Fedora's bash queries the terminal at startup (OSC 10/11 colors, DSR
   * cursor report) and prints a fastfetch banner before its first prompt. In
   * production xterm.js answers the queries automatically; headless tests
   * must emulate that — and type only once the shell has settled.
   */
  function responder(manager: TerminalManager) {
    const seen = new Map<string, string>();
    return {
      onData: (id: string, d: string) => {
        const prev = seen.get(id) ?? '';
        seen.set(id, prev + d);
        if (d.includes('\u001b]11;?')) manager.write(id, '\u001b]11;rgb:0c0c/0c0c/0c0c\u001b\\');
        if (d.includes('\u001b]10;?')) manager.write(id, '\u001b]10;rgb:e5e5/e5e5/e5e5\u001b\\');
        if (d.includes('\u001b[6n')) manager.write(id, '\u001b[1;1R');
      },
      textOf: (id: string) => seen.get(id) ?? '',
    };
  }

  /** Writes once the shell has been silent for 800ms (startup banner done). */
  async function writeWhenIdle(
    terminal: ReturnType<typeof responder>,
    manager: TerminalManager,
    id: string,
    cmd: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const started = Date.now();
    let lastLen = -1;
    let lastChange = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const len = terminal.textOf(id).length;
      if (len !== lastLen) {
        lastLen = len;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange > 800) break;
      if (Date.now() - started > timeoutMs) break;
    }
    manager.write(id, cmd);
  }

  it('spawns a shell in the project dir, streams output and kills cleanly', async () => {
    const manager = new TerminalManager(quietLogger);
    const data: Record<string, string> = {};
    const exited: string[] = [];
    const listed: number[] = [];
    const terminal = responder(manager);
    const broadcasts = {
      onData: (id: string, d: string) => {
        terminal.onData(id, d);
        data[id] = (data[id] ?? '') + d;
      },
      onExit: (id: string) => exited.push(id),
      onList: () => listed.push(Date.now()),
    };

    const info = manager.spawn('/tmp', 'p1', 60, 20, broadcasts);
    expect(info.projectId).toBe('p1');

    await writeWhenIdle(terminal, manager, info.id, 'echo AGENTDECK_PTY_$((40+2))\r');
    await waitsFor(() => (data[info.id] ?? '').includes('AGENTDECK_PTY_42'));

    await writeWhenIdle(terminal, manager, info.id, 'pwd\r');
    await waitsFor(() => (data[info.id] ?? '').includes('/tmp'));

    expect(manager.list('p1')).toHaveLength(1);
    expect(manager.replayOf(info.id)).toContain('AGENTDECK_PTY_42');

    expect(manager.resize(info.id, 100, 30)).toBe(true);
    expect(manager.get(info.id)?.info.cols).toBe(100);

    manager.kill(info.id, broadcasts);
    expect(exited).toContain(info.id); // synchronous broadcast + removal
    expect(manager.list()).toHaveLength(0);
    expect(manager.write(info.id, 'x')).toBe(false);
  });

  it('caps concurrency by reaping the oldest terminal', async () => {
    const manager = new TerminalManager(quietLogger);
    const broadcasts = { onData: () => undefined, onExit: () => undefined, onList: () => undefined };
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(manager.spawn('/tmp', 'p1', 60, 20, broadcasts).id);
    }
    expect(manager.list()).toHaveLength(6);
    expect(manager.get(ids[0])).toBeUndefined();
    expect(manager.get(ids[7])).toBeDefined();
    manager.killAll();
    expect(manager.list()).toHaveLength(0);
  });
});
