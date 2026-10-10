// electron-builder configuration: AppImage + deb (x64). Plain JS so the server bundle can be checked
// (and relocated for tests via AGENTDECK_SERVER_BUNDLE) before anything is packed.
const fs = require('node:fs');
const path = require('node:path');

const bundle = path.resolve(process.env.AGENTDECK_SERVER_BUNDLE || path.join(__dirname, '..', 'dist-bundle', 'agentdeck-server'));
if (!fs.existsSync(path.join(bundle, 'bin', 'agentdeck-server'))) {
  throw new Error(`Server bundle missing at ${bundle} — build it first: scripts/build-server-bundle.sh`);
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.agentdeck.desktop',
  productName: 'AgentDeck',
  copyright: 'Copyright (c) 2026 Ninjalama1337',
  artifactName: 'AgentDeck-${version}-linux-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json'],
  // The server (Node, tmux, the built app) rides along as plain files — the shell drives it through its CLI.
  extraResources: [{ from: bundle, to: 'server' }],
  asar: true,
  electronLanguages: ['en-US', 'de'],
  // Releases are created by .github/workflows/android.yml; this only makes electron-builder write latest-linux.yml.
  publish: [{ provider: 'github', owner: 'Ninjalama1337', repo: 'agentdeck' }],
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    // The binary, its desktop entry, the icon and the autostart entry (src/core/autostart.ts) share this name.
    executableName: 'agentdeck',
    syncDesktopName: true,
    category: 'Development',
    icon: path.join(__dirname, '..', 'web', 'public', 'icons', 'icon-512.png'),
    maintainer: 'Ninjalama <miron.schueler@gmail.com>',
    synopsis: 'Window on your AgentDeck server',
    description: 'AgentDeck desktop app: a window on the AgentDeck server that runs your coding agents. Includes the server.',
    desktop: {
      entry: {
        Name: 'AgentDeck',
        Comment: 'Control your coding agents',
        Categories: 'Development;',
        Keywords: 'agent;claude;codex;terminal;',
      },
    },
  },
  deb: {
    packageCategory: 'devel',
    recommends: ['git'],
  },
};
