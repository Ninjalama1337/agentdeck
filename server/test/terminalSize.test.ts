import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { TerminalManager } from '../src/term/manager.js';
import { getTmuxBinary, isTmuxAvailable, tmuxSessionName, tmuxSocketPath } from '../src/term/tmux.js';
import type { Logger } from '../src/logging.js';

/**
 * A PTY has one size, and every device showing the terminal takes it: a phone
 * is ~51 columns wide, a desktop 120. Laid out for one and drawn into the
 * other, every line is too long and wraps into the next, and those torn rows
 * stay in the scrollback — the screen becomes a staircase of half sentences.
 *
 * Both sides are held here: the tmux window must never be wider than the
 * client that draws it (TerminalManager.applySize), and a snapshot must come
 * at exactly the size its client draws (attachView).
 */

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long, indented lines like an agent's message block — wider than a phone. */
const PRINT_LONG_LINES =
  'for i in $(seq 1 20); do printf "        Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore %02d\\n" $i; done';

async function waitsFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

/** The pane as tmux has it: history and visible screen, one string per row. */
function paneRows(session: string): string[] {
  const raw = execFileSync(
    getTmuxBinary() as string,
    ['-S', tmuxSocketPath(), 'capture-pane', '-p', '-S', '-5000', '-t', session],
    { encoding: 'utf-8' },
  );
  return trimRows(raw.split('\n'));
}

/** What a client of that size draws from the replay the server hands out. */
async function replayRows(cols: number, rows: number, replay: string): Promise<string[]> {
  const screen = new xtermHeadless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => screen.write(replay, () => resolve()));
    const buffer = screen.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.baseY + screen.rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return trimRows(lines);
  } finally {
    screen.dispose();
  }
}

/** Trailing blanks make no picture — and tmux pads its rows. */
function trimRows(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ''));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/**
 * Longest run of text a stream draws between two cursor commands — a row of
 * the screen. tmux writes a row in one go, so a run longer than the client is
 * wide is a row of a wider window that the client has to wrap.
 */
function longestRun(data: string): number {
  const text = data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '');
  return Math.max(0, ...text.split('\n').map((line) => line.length));
}

function sameRows(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** The login banner prints in bursts — wait until the picture holds still. */
async function settledPane(session: string, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last = paneRows(session);
  while (Date.now() < deadline) {
    await sleep(100);
    const next = paneRows(session);
    if (sameRows(next, last)) return next;
    last = next;
  }
  return last;
}

/**
 * The mirror the server serializes must be the pane tmux has — row for row.
 * Torn rows (a fragment at column 0, the sentence restarting at column 8)
 * are exactly what a snapshot laid out for another width looks like.
 */
async function expectMirrorMatchesPane(manager: TerminalManager, id: string, session: string, cols: number, rows: number): Promise<void> {
  let drawn: string[] = [];
  let pane: string[] = [];
  for (let i = 0; i < 80; i++) {
    drawn = await replayRows(cols, rows, manager.replayOf(id) ?? '');
    pane = paneRows(session);
    if (sameRows(drawn, pane)) return;
    await sleep(50);
  }
  expect(drawn).toEqual(pane);
}

describe.skipIf(!isTmuxAvailable())('Terminal size (tmux backed)', () => {
  /**
   * A plain login shell, then the lines are typed into it: no second banner
   * (a launch command ends in `exec $SHELL -l`) keeps the picture still.
   */
  async function shellWithLongLines(): Promise<{ manager: TerminalManager; id: string; session: string; dir: string; out: () => string; broadcast: typeof broadcasts }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-size-'));
    const manager = new TerminalManager(quietLogger, { dataDir: dir, useTmux: true });
    let out = '';
    const broadcasts = { onData: (_id: string, d: string) => (out += d), onExit: () => undefined, onList: () => undefined };
    const info = manager.spawn('/tmp', 'p1', 120, 30, broadcasts, { title: 'size' });
    const session = tmuxSessionName(info.id);
    await settledPane(session);
    // Wipe the login banner — screen and tmux history: the picture under test
    // is the block printed below, nothing else.
    manager.write(info.id, `printf '\\033[2J\\033[3J\\033[H'\r`);
    await sleep(300);
    execFileSync(getTmuxBinary() as string, ['-S', tmuxSocketPath(), 'clear-history', '-t', session], { stdio: 'ignore' });
    await settledPane(session);
    manager.write(info.id, `${PRINT_LONG_LINES}\r`);
    await waitsFor(() => out.includes('labore 20'));
    await settledPane(session);
    return { manager, id: info.id, session, dir, out: () => out, broadcast: broadcasts };
  }

  it('hands a client the screen at the size it draws', async () => {
    const t = await shellWithLongLines();
    try {
      // A phone opens the terminal: 51 columns, while the desktop left it at 120.
      const view = await t.manager.attachView(t.id, 51, 26, t.broadcast);
      expect(view?.info.cols).toBe(51);
      expect(view?.info.rows).toBe(26);
      // The PTY follows: the next device that asks gets it at its size.
      expect(t.manager.get(t.id)?.info.cols).toBe(51);

      // What the phone draws is the pane — not a 120-column screen wrapped into 51.
      expect(await replayRows(51, 26, view?.replay ?? '')).toEqual(await settledPane(t.session));
      expect(t.manager.replayOf(t.id)).toContain('labore 20');
    } finally {
      t.manager.killAll();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('keeps the mirror readable when a resize shrinks the PTY', async () => {
    const t = await shellWithLongLines();
    try {
      const mark = t.out().length;
      expect(t.manager.resize(t.id, 51, 26, undefined, t.broadcast)).toBe(true);

      // Nothing wider than the client may be drawn into it — a row of the old
      // width wraps there and stays in the scrollback as torn text.
      expect(longestRun(t.out().slice(mark))).toBeLessThanOrEqual(51);

      await expectMirrorMatchesPane(t.manager, t.id, t.session, 51, 26);
    } finally {
      t.manager.killAll();
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
