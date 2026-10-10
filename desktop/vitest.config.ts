import { defineConfig } from 'vitest/config';

// Plain node tests: core modules take their dependencies as arguments, so
// neither Electron nor systemd is involved.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
