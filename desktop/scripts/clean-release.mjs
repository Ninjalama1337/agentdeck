// The unpacked app dir is shared by the deb and the AppImage run, but the AppImage run changes it
// (launcher script, build/after-pack-appimage.cjs) — never let one leak into the other.
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const release = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'release');
rmSync(resolve(release, 'linux-unpacked'), { recursive: true, force: true });
