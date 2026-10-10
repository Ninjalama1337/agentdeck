// Bundles the Electron main + preload with esbuild into dist/ and copies the icon.
// Types are checked separately (npm run typecheck).
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
  legalComments: 'none',
};

// Main process: Node built-ins stay external automatically, Electron is provided at runtime.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(dist, 'main.js'),
  external: ['electron'],
});

// Preload runs sandboxed: one self-contained file, only `electron` may be required.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/preload.ts')],
  outfile: resolve(dist, 'preload.js'),
  external: ['electron'],
});

// Window icon (the packaged desktop entry brings its own).
await copyFile(resolve(root, '../web/public/icons/icon-512.png'), resolve(dist, 'icon.png'));
