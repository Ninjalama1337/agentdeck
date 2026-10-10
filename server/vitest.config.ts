import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Own tmux socket for the test run: terminal tests must never touch the
// sessions of an AgentDeck server running on the same machine.
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-'));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
    env: { XDG_RUNTIME_DIR: runtimeDir },
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
