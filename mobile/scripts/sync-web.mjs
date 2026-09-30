#!/usr/bin/env node
/**
 * Copies ../../web/dist -> mobile/dist so `cap copy` / `cap sync` find the
 * built web app (webDir is relative to mobile/). Plain Node, no dependencies.
 *
 * If web/dist does not exist (web app not built yet), a minimal fallback
 * index.html is written so the Android toolchain still builds — the APK then
 * shows a hint instead of a white screen.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(mobileDir, '..', 'web', 'dist');
const dest = join(mobileDir, 'dist');

const fallbackHtml = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentDeck</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #101418; color: #e8eaed;
           display: grid; place-items: center; min-height: 100vh; margin: 0; }
    main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
    code { background: #1d232a; padding: .15rem .4rem; border-radius: .3rem; }
  </style>
</head>
<body>
  <main>
    <h1>AgentDeck</h1>
    <p>Die Web-App wurde noch nicht gebaut. Führe im Repository-Root aus:</p>
    <p><code>npm run build -w packages/shared && npm run build -w web</code></p>
    <p>und danach im Repo-Root <code>npm run sync -w mobile</code> bzw.
    <code>scripts/build-android.sh</code>.</p>
  </main>
</body>
</html>
`;

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`[sync-web] copied ${src} -> ${dest}`);
} else {
  writeFileSync(join(dest, 'index.html'), fallbackHtml, 'utf8');
  console.warn(
    `[sync-web] WARNING: ${src} not found — wrote fallback index.html. ` +
      `Run 'npm run build -w web' (or 'npm run sync -w mobile') first.`,
  );
}
