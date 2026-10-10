import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalManager } from '../src/term/manager.js';
import type { Logger } from '../src/logging.js';
import { _resetTmuxCache, hasTmuxSession, tmuxSessionState } from '../src/term/tmux.js';

/** A stand-in for tmux that answers `-V` and fails `has-session` with the given message. */
function fakeTmux(dir: string, stderr: string, status = 1): string {
  const file = path.join(dir, 'fake-tmux');
  fs.writeFileSync(
    file,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-V" ]; then echo "tmux 9.9"; exit 0; fi
  if [ "$a" = "has-session" ]; then
    ${stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''}
    exit ${status}
  fi
done
exit 0
`,
    { mode: 0o755 },
  );
  return file;
}

const logged: { level: string; msg: string }[] = [];
const recordingLogger: Logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: (_o: unknown, msg?: string) => void logged.push({ level: 'warn', msg: String(msg) }),
  error: (_o: unknown, msg?: string) => void logged.push({ level: 'error', msg: String(msg) }),
  fatal: () => undefined,
  child: () => recordingLogger,
} as unknown as Logger;

const broadcasts = { onData: () => undefined, onExit: () => undefined, onList: () => undefined };

let tmp = '';
let oldTmux: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-tmuxstate-'));
  oldTmux = process.env.AGENTDECK_TMUX;
  logged.length = 0;
});

afterEach(() => {
  if (oldTmux === undefined) delete process.env.AGENTDECK_TMUX;
  else process.env.AGENTDECK_TMUX = oldTmux;
  _resetTmuxCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function useTmux(stderr: string, status = 1): void {
  process.env.AGENTDECK_TMUX = fakeTmux(tmp, stderr, status);
  _resetTmuxCache();
}

describe('tmuxSessionState', () => {
  it('is alive when tmux finds the session', () => {
    useTmux('', 0);
    expect(tmuxSessionState('ad_x')).toBe('alive');
    expect(hasTmuxSession('ad_x')).toBe(true);
  });

  it.each([
    ['no server running on /run/user/1000/agentdeck-tmux.sock'],
    ["can't find session: ad_x"],
    ['no sessions'],
    ['error connecting to /run/user/1000/agentdeck-tmux.sock (No such file or directory)'],
    ['error connecting to /run/user/1000/agentdeck-tmux.sock (Connection refused)'],
  ])('is absent when tmux itself says so: %s', (message) => {
    useTmux(message);
    expect(tmuxSessionState('ad_x')).toBe('absent');
    expect(hasTmuxSession('ad_x')).toBe(false);
  });

  it.each([
    ['server exited unexpectedly'],
    ['protocol version mismatch (client 8, server 7)'],
    ['error connecting to /x/agentdeck-tmux.sock (Permission denied)'],
    ['error connecting to /very/long/agentdeck-tmux.sock (File name too long)'],
    [''],
  ])('is unknown when tmux cannot tell: "%s"', (message) => {
    useTmux(message);
    expect(tmuxSessionState('ad_x')).toBe('unknown');
    expect(hasTmuxSession('ad_x')).toBe(false);
  });
});

describe('restoring saved terminals', () => {
  const record = (id: string, tmuxSession?: string) => ({
    info: { id, projectId: 'p', createdAt: 1, cols: 80, rows: 24, title: 'shell', presetId: 'shell', persistent: true },
    projectPath: os.tmpdir(),
    ...(tmuxSession ? { tmuxSession } : {}),
  });
  const saved = () => JSON.parse(fs.readFileSync(path.join(tmp, 'terminals.json'), 'utf8')) as { info: { id: string } }[];

  function restore(records: unknown[]): void {
    fs.writeFileSync(path.join(tmp, 'terminals.json'), JSON.stringify(records));
    new TerminalManager(recordingLogger, { dataDir: tmp, useTmux: true }).restoreAll(broadcasts);
  }

  it('drops a record when tmux says the session is gone', () => {
    useTmux("can't find session: ad_t_1");
    restore([record('t_1', 'ad_t_1'), record('t_2')]);
    expect(saved()).toEqual([]);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('keeps the record — and says so loudly — when tmux cannot be asked (another version than the running tmux server)', () => {
    useTmux('server exited unexpectedly');
    restore([record('t_1', 'ad_t_1'), record('t_2')]);
    // the plain-PTY record had no tmux session to wait for; the tmux one stays in the file
    expect(saved().map((r) => r.info.id)).toEqual(['t_1']);
    const errors = logged.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toMatch(/cannot ask tmux.*keeping it/);
  });

  it('keeps unrestored records through later saves of the manager', () => {
    useTmux('server exited unexpectedly');
    fs.writeFileSync(path.join(tmp, 'terminals.json'), JSON.stringify([record('t_1', 'ad_t_1')]));
    const manager = new TerminalManager(recordingLogger, { dataDir: tmp, useTmux: true });
    manager.restoreAll(broadcasts);
    manager.detachAll(); // saves the state on the way out
    expect(saved().map((r) => r.info.id)).toEqual(['t_1']);
  });
});
