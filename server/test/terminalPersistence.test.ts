import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../src/term/manager.js';
import type { Logger } from '../src/logging.js';
import {
  isTmuxAvailable,
  hasTmuxSession,
  killTmuxSession,
  tmuxSessionName,
  tmuxSocketPath,
} from '../src/term/tmux.js';

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

describe('Terminal Persistence (tmux backed)', () => {
  it('detects tmux availability', () => {
    expect(isTmuxAvailable()).toBe(true);
  });

  it('enables mouse on create and re-applies it when restoring legacy sessions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mouse-test-'));
    const broadcasts = {
      onData: () => undefined,
      onExit: () => undefined,
      onList: () => undefined,
    };
    try {
      const manager1 = new TerminalManager(quietLogger, { dataDir: tempDir, useTmux: true });
      const info = manager1.spawn('/tmp', 'p1', 80, 24, broadcasts, { title: 'mouse-test' });
      expect(info.persistent).toBe(true);
      const session = tmuxSessionName(info.id);
      const mouseOption = () =>
        execFileSync('tmux', ['-S', tmuxSocketPath(), 'show-options', '-t', session, 'mouse'], {
          encoding: 'utf-8',
        }).trim();

      expect(mouseOption()).toBe('mouse on');

      // Simulate a session created before the option existed, then a server
      // restart: restoring must re-apply session options.
      execFileSync('tmux', ['-S', tmuxSocketPath(), 'set-option', '-t', session, 'mouse', 'off'], { stdio: 'ignore' });
      manager1.detachAll();
      expect(hasTmuxSession(session)).toBe(true);

      const manager2 = new TerminalManager(quietLogger, { dataDir: tempDir, useTmux: true });
      manager2.restoreAll(broadcasts);
      expect(manager2.list().map((t) => t.id)).toContain(info.id);
      expect(mouseOption()).toBe('mouse on');

      manager2.kill(info.id, broadcasts);
      expect(hasTmuxSession(session)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists a terminal session across server detachment and restores on restart', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-persist-test-'));
    try {
      let dataReceived1 = '';
      const broadcasts1 = {
        onData: (_id: string, d: string) => {
          dataReceived1 += d;
        },
        onExit: () => undefined,
        onList: () => undefined,
      };

      // 1. First server instance spawns a persistent terminal
      const manager1 = new TerminalManager(quietLogger, {
        dataDir: tempDir,
        useTmux: true,
      });

      const info = manager1.spawn('/tmp', 'p1', 80, 24, broadcasts1, {
        title: 'persistent-shell',
        command: 'echo INITIAL_STARTUP_OK',
      });

      expect(info.persistent).toBe(true);
      const session = tmuxSessionName(info.id);

      await waitsFor(() => dataReceived1.includes('INITIAL_STARTUP_OK'));
      expect(hasTmuxSession(session)).toBe(true);

      // Verify state was saved to terminals.json
      const jsonPath = path.join(tempDir, 'terminals.json');
      expect(fs.existsSync(jsonPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(saved).toHaveLength(1);
      expect(saved[0].info.id).toBe(info.id);

      // 2. Server shutdown simulation: detachAll
      manager1.detachAll();

      // Crucial: tmux session MUST stay alive in the background!
      expect(hasTmuxSession(session)).toBe(true);

      // 3. Second server instance boots up and restores terminals
      let dataReceived2 = '';
      const broadcasts2 = {
        onData: (_id: string, d: string) => {
          dataReceived2 += d;
        },
        onExit: () => undefined,
        onList: () => undefined,
      };

      const manager2 = new TerminalManager(quietLogger, {
        dataDir: tempDir,
        useTmux: true,
      });

      manager2.restoreAll(broadcasts2);

      const list = manager2.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(info.id);
      expect(list[0].persistent).toBe(true);

      // Replay must contain the output before the restart
      const replay = manager2.replayOf(info.id);
      expect(replay).toContain('INITIAL_STARTUP_OK');

      // 4. Send new input into the restored terminal
      manager2.write(info.id, 'echo RESTORED_AND_RUNNING\r');
      await waitsFor(() => dataReceived2.includes('RESTORED_AND_RUNNING'));

      // 5. Clean up: explicitly killing the terminal should terminate the tmux session
      manager2.kill(info.id, broadcasts2);
      expect(manager2.list()).toHaveLength(0);
      expect(hasTmuxSession(session)).toBe(false);

      // Check terminals.json is cleared
      const savedAfter = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(savedAfter).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
