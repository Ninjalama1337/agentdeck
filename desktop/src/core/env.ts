/** Variables that only make sense inside Electron / an AppImage and must not reach the server. */
const DROPPED = new Set(['NODE_OPTIONS', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'CHROME_WRAPPER']);

/** Colon-separated lists the AppImage runtime prepends its own mount to. */
const PATH_LISTS = [
  'PATH',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'XDG_DATA_DIRS',
  'PYTHONPATH',
  'PERLLIB',
  'QT_PLUGIN_PATH',
  'GSETTINGS_SCHEMA_DIR',
  'GST_PLUGIN_SYSTEM_PATH',
];

/**
 * Environment for the server and its CLI: ours minus everything Electron or the
 * AppImage runtime injected. The server must never see (or later depend on) the
 * AppImage mount — it vanishes when the app exits.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const appDir = env.APPDIR;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (DROPPED.has(key) || key.startsWith('ELECTRON_')) continue;
    if (appDir && PATH_LISTS.includes(key)) {
      const kept = value.split(':').filter((entry) => entry !== '' && !entry.startsWith(appDir));
      if (kept.length > 0) out[key] = kept.join(':');
      continue;
    }
    out[key] = value;
  }
  return out;
}
