import { describe, expect, it } from 'vitest';
import { Autostart, autostartEntry, autostartTarget, HIDDEN_FLAG, quoteExecArg } from '../src/core/autostart';
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
