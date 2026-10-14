import path from 'node:path';
import { writeFileAtomic, type FileSystem } from './fs';

/**
 * `<dataDir>/desktop-app.json`: where this app is installed, for the server
 * (server/src/update/desktop.ts). With it, Settings → Server update on the
 * phone can replace the AppImage remotely; a deb tells the server not to try.
 * Rewritten on every start, so a moved AppImage is found again.
 */
export const REGISTRATION_FILE = 'desktop-app.json';

export interface Registration {
  version: string;
  packageType: 'appimage' | 'deb';
  appImage?: string;
}

/** Null for a development run: there is nothing for the server to update. */
export function registrationFor(env: NodeJS.ProcessEnv, version: string, packaged: boolean): Registration | null {
  if (!packaged) return null;
  if (env.APPIMAGE && path.isAbsolute(env.APPIMAGE)) return { version, packageType: 'appimage', appImage: env.APPIMAGE };
  return { version, packageType: 'deb' };
}

export async function writeRegistration(fs: FileSystem, dataDir: string, registration: Registration): Promise<void> {
  await writeFileAtomic(fs, path.join(dataDir, REGISTRATION_FILE), `${JSON.stringify(registration, null, 2)}\n`, 0o644);
}
