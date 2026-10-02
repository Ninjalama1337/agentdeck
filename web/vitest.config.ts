import { defineConfig } from 'vitest/config';

// Plain node tests for storage/logic modules — deliberately separate from
// vite.config.ts so the PWA build plugins stay out of the test run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
