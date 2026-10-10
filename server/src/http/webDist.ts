import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the built web app, or undefined when not built. Lives apart
 * from app.ts so the CLI (`info`) can ask without loading the whole server.
 */
export function findWebDist(): string | undefined {
  if (process.env.AGENTDECK_WEB_DIST) {
    const envCandidate = path.resolve(process.env.AGENTDECK_WEB_DIST);
    if (fs.existsSync(path.join(envCandidate, 'index.html'))) return envCandidate;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/http (tsx dev) → ../../web/dist ; dist/http (built) → ../../../web/dist
  // (a packaged bundle has the same shape: app/server/dist/http → app/web/dist)
  const candidates = [path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist')];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}
