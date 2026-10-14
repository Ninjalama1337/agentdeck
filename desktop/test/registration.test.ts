import { describe, expect, it } from 'vitest';
import { readJsonFile } from '../src/core/fs';
import { registrationFor, writeRegistration } from '../src/core/registration';
import { MemFs } from './helpers/memFs';

describe('desktop app registration', () => {
  it('records the AppImage, a deb, and nothing for a development run', () => {
    expect(registrationFor({ APPIMAGE: '/home/me/AppImages/agentdeck.appimage' }, '1.2.3', true)).toEqual({
      version: '1.2.3',
      packageType: 'appimage',
      appImage: '/home/me/AppImages/agentdeck.appimage',
    });
    expect(registrationFor({}, '1.2.3', true)).toEqual({ version: '1.2.3', packageType: 'deb' });
    expect(registrationFor({ APPIMAGE: 'relative.AppImage' }, '1.2.3', true)).toEqual({ version: '1.2.3', packageType: 'deb' });
    expect(registrationFor({ APPIMAGE: '/x.AppImage' }, '1.2.3', false)).toBeNull();
  });

  it('writes desktop-app.json into the data dir', async () => {
    const fs = new MemFs();
    await fs.mkdirp('/data');
    await writeRegistration(fs, '/data', { version: '1.2.3', packageType: 'appimage', appImage: '/a.AppImage' });
    expect(await readJsonFile(fs, '/data/desktop-app.json')).toEqual({ version: '1.2.3', packageType: 'appimage', appImage: '/a.AppImage' });
  });
});
