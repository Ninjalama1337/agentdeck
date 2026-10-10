// electron-builder afterPack hook for the AppImage run only (npm run dist:appimage):
// the Electron binary becomes agentdeck.bin and build/linux/agentdeck-launcher.sh takes its place.
// Not used for the deb — its AppArmor profile (electron-builder's default) covers the real binary.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const exe = context.packager.executableName;
  const target = path.join(context.appOutDir, exe);
  const real = `${target}.bin`;
  if (fs.existsSync(real)) throw new Error(`${real} exists already — clean the release dir (scripts/clean-release.mjs)`);
  fs.renameSync(target, real);
  fs.copyFileSync(path.join(__dirname, 'linux', 'agentdeck-launcher.sh'), target);
  fs.chmodSync(target, 0o755);
};
