import { describe, expect, it } from 'vitest';
import { Autostart, autostartEntry, autostartTarget, HIDDEN_FLAG, isEntryDisabled, quoteExecArg } from '../src/core/autostart';
import { MemFs } from './helpers/memFs';

describe('quoteExecArg', () => {
  it('leaves plain paths alone and quotes everything with special characters', () => {
    expect(quoteExecArg('/opt/AgentDeck/agentdeck')).toBe('/opt/AgentDeck/agentdeck');
    expect(quoteExecArg('/home/me/My Apps/AgentDeck.AppImage')).toBe('"/home/me/My Apps/AgentDeck.AppImage"');
    expect(quoteExecArg('a"b')).toBe('"a\\\\"b"');
    expect(quoteExecArg('a$b')).toBe('"a\\\\$b"');
    expect(quoteExecArg('50%')).toBe('"50%%"');
    expect(quoteExecArg('a\\b')).toBe('"a\\\\\\\\b"');
  });
});

describe('autostartEntry', () => {
  it('starts the app hidden', () => {
    const entry = autostartEntry({ execPath: '/opt/AgentDeck/agentdeck' });
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain(`Exec=/opt/AgentDeck/agentdeck ${HIDDEN_FLAG}\n`);
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('puts extra arguments before --hidden (development runs)', () => {
    expect(autostartEntry({ execPath: '/x/electron', args: ['/repo/desktop'] })).toContain('Exec=/x/electron /repo/desktop --hidden');
  });
});

describe('autostartTarget', () => {
  it('uses the AppImage file, not the short-lived mount inside it', () => {
    expect(autostartTarget({ APPIMAGE: '/home/me/AgentDeck.AppImage' }, '/tmp/.mount_xyz/agentdeck')).toBe('/home/me/AgentDeck.AppImage');
    expect(autostartTarget({}, '/opt/AgentDeck/agentdeck')).toBe('/opt/AgentDeck/agentdeck');
    expect(autostartTarget({ APPIMAGE: 'relative.AppImage' }, '/opt/x')).toBe('/opt/x');
  });
});

describe('Autostart', () => {
  it('writes, rewrites and removes the entry', async () => {
    const fs = new MemFs();
    const file = '/home/me/.config/autostart/agentdeck.desktop';
    let target = '/old/AgentDeck.AppImage';
    const autostart = new Autostart(fs, file, () => ({ execPath: target }));
    expect(await autostart.isEnabled()).toBe(false);
    await autostart.set(true);
    expect(await autostart.isEnabled()).toBe(true);
    expect(await fs.readFile(file)).toContain('/old/AgentDeck.AppImage');
    target = '/new/AgentDeck.AppImage';
    await autostart.set(true);
    expect(await fs.readFile(file)).toContain('/new/AgentDeck.AppImage');
    await autostart.set(false);
    expect(await autostart.isEnabled()).toBe(false);
    await autostart.set(false);
  });
});

describe('an entry the desktop switched off', () => {
  const FILE = '/home/me/.config/autostart/agentdeck.desktop';
  const made = (target: string) => autostartEntry({ execPath: target });
  const setup = (text: string, target = '/apps/AgentDeck.AppImage') => {
    const fs = new MemFs({ [FILE]: text });
    return { fs, autostart: new Autostart(fs, FILE, () => ({ execPath: target })) };
  };

  it('knows the switches GNOME Tweaks and KDE write', () => {
    expect(isEntryDisabled(made('/x'))).toBe(false);
    expect(isEntryDisabled(`${made('/x')}Hidden=true\n`)).toBe(true);
    expect(isEntryDisabled(made('/x').replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'))).toBe(true);
    expect(isEntryDisabled('[Desktop Entry]\nHidden=false\nExec=x\n')).toBe(false);
    // only the main group counts
    expect(isEntryDisabled('[Desktop Entry]\nExec=x\n[Desktop Action a]\nHidden=true\n')).toBe(false);
  });

  it('reports it as off, and the app turning it on writes a clean entry again', async () => {
    const { fs, autostart } = setup(`${made('/apps/AgentDeck.AppImage')}Hidden=true\n`);
    expect(await autostart.isEnabled()).toBe(false);
    await autostart.set(true);
    expect(await autostart.isEnabled()).toBe(true);
    expect(await fs.readFile(FILE)).not.toContain('Hidden=true');
  });

  it('healing never switches an entry back on', async () => {
    const off = made('/old/AgentDeck.AppImage').replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false') + 'Hidden=true\n';
    const { fs, autostart } = setup(off, '/new/AgentDeck.AppImage');
    expect(await autostart.healExec()).toBe(true);
    const text = await fs.readFile(FILE);
    expect(text).toContain('Exec=/new/AgentDeck.AppImage --hidden');
    expect(text).toContain('X-GNOME-Autostart-enabled=false');
    expect(text).toContain('Hidden=true');
    expect(await autostart.isEnabled()).toBe(false);
  });

  it('healing leaves a correct entry untouched, and does not create one', async () => {
    const { fs, autostart } = setup(made('/apps/AgentDeck.AppImage'));
    const before = fs.files.get(FILE);
    expect(await autostart.healExec()).toBe(false);
    expect(fs.files.get(FILE)).toBe(before);
    const empty = new Autostart(new MemFs(), FILE, () => ({ execPath: '/x' }));
    expect(await empty.healExec()).toBe(false);
    expect(await empty.isEnabled()).toBe(false);
  });

  it('keeps extra keys the desktop added when it rewrites the Exec line', async () => {
    const { fs, autostart } = setup(`${made('/old/x')}X-KDE-autostart-after=panel\nName[de]=AgentDeck\n`, '/new/x');
    await autostart.healExec();
    const text = await fs.readFile(FILE);
    expect(text).toContain('X-KDE-autostart-after=panel');
    expect(text).toContain('Name[de]=AgentDeck');
    expect(text).toContain('Exec=/new/x --hidden');
  });
});
