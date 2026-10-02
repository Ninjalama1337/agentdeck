import { beforeEach, describe, expect, it, vi } from 'vitest';

type Servers = typeof import('../src/api/servers');

let store: Map<string, string>;

/** Fresh module (its state is cached per page load) over the given storage. */
async function load(initial: Record<string, string> = {}): Promise<Servers> {
  store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.resetModules();
  return import('../src/api/servers');
}

/** Same storage, new page load. */
async function reload(): Promise<Servers> {
  vi.resetModules();
  return import('../src/api/servers');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('saved servers', () => {
  it('starts with one unpaired same-origin profile on a fresh install', async () => {
    const servers = await load();
    expect(servers.listServers()).toEqual([{ id: 'default', name: '', base: '', token: null }]);
    expect(servers.getActiveServer().id).toBe('default');
  });

  it('carries an existing single-server login over unchanged', async () => {
    const servers = await load({
      'agentdeck:token': 'jwt-old',
      'agentdeck:server': 'https://deck.example.com/',
      'agentdeck:project': 'p_1',
    });
    expect(servers.getActiveServer()).toEqual({
      id: 'default',
      name: '',
      base: 'https://deck.example.com',
      token: 'jwt-old',
    });
    // Per-server data of the migrated profile is read from the keys it was written to.
    expect(servers.scopedKey('agentdeck:project')).toBe('agentdeck:project');
    expect(store.get('agentdeck:project')).toBe('p_1');
    expect(store.has('agentdeck:token')).toBe(false);
    expect(store.has('agentdeck:server')).toBe(false);

    const again = await reload();
    expect(again.getActiveServer().token).toBe('jwt-old');
  });

  it('keeps one login per server and switches between them', async () => {
    let servers = await load({ 'agentdeck:token': 'jwt-a', 'agentdeck:server': 'https://a.example.com' });
    servers.updateActiveServer({ name: 'bazzite' });

    const added = servers.addServer();
    expect(servers.getActiveServer()).toEqual({ id: added.id, name: '', base: '', token: null });
    servers.updateActiveServer({ base: 'http://10.0.1.80:8787/', token: 'jwt-b', name: 'hpminipc' });
    expect(servers.scopedKey('agentdeck:inbox')).toBe(`agentdeck:inbox@${added.id}`);

    servers = await reload();
    expect(servers.getActiveServer()).toMatchObject({ base: 'http://10.0.1.80:8787', token: 'jwt-b' });

    expect(servers.activateServer('default')).toBe(true);
    expect(servers.getActiveServer()).toMatchObject({ name: 'bazzite', token: 'jwt-a' });
    expect(servers.scopedKey('agentdeck:inbox')).toBe('agentdeck:inbox');
    expect(servers.listServers().map((s) => s.token)).toEqual(['jwt-a', 'jwt-b']);
    expect(servers.activateServer('nope')).toBe(false);
  });

  it('drops a server that was added but never paired once the user moves on', async () => {
    const servers = await load({ 'agentdeck:token': 'jwt-a' });
    servers.updateActiveServer({ name: 'bazzite' });
    servers.addServer();
    expect(servers.listServers()).toHaveLength(2);
    servers.activateServer('default');
    expect(servers.listServers().map((s) => s.id)).toEqual(['default']);
  });

  it('keeps a server whose pairing expired, so it can be paired again', async () => {
    const servers = await load({ 'agentdeck:token': 'jwt-a', 'agentdeck:server': 'https://a.example.com' });
    servers.updateActiveServer({ name: 'bazzite' });
    const b = servers.addServer('http://10.0.1.80:8787');
    servers.updateActiveServer({ token: 'jwt-b', name: 'hpminipc' });
    servers.updateActiveServer({ token: null }); // unpaired / 401
    servers.activateServer('default');
    expect(servers.listServers().find((s) => s.id === b.id)).toMatchObject({ name: 'hpminipc', token: null });
  });

  it('removing a server forgets its login and data and falls back to another', async () => {
    const servers = await load({ 'agentdeck:token': 'jwt-a' });
    servers.updateActiveServer({ name: 'bazzite' });
    const b = servers.addServer('http://10.0.1.80:8787');
    servers.updateActiveServer({ token: 'jwt-b', name: 'hpminipc' });
    store.set(`agentdeck:project@${b.id}`, 'p_9');

    servers.removeServer(b.id);
    expect(store.has(`agentdeck:project@${b.id}`)).toBe(false);
    expect(servers.getActiveServer().id).toBe('default');
    expect(JSON.stringify([...store.values()])).not.toContain('jwt-b');

    store.set('agentdeck:inbox', '[]');
    servers.removeServer('default');
    expect(servers.listServers()).toEqual([{ id: 'default', name: '', base: '', token: null }]);
    expect(store.has('agentdeck:inbox')).toBe(false);
  });

  it('finds a saved server by address regardless of trailing slashes', async () => {
    const servers = await load({ 'agentdeck:token': 'jwt-a', 'agentdeck:server': 'https://a.example.com' });
    expect(servers.findServerByBase('https://a.example.com/')?.id).toBe('default');
    expect(servers.findServerByBase('https://other.example.com')).toBeUndefined();
  });

  it('recovers from unreadable storage content', async () => {
    const servers = await load({ 'agentdeck:servers': '{not json', 'agentdeck:token': 'jwt-a' });
    expect(servers.getActiveServer().token).toBe('jwt-a');
  });
});
