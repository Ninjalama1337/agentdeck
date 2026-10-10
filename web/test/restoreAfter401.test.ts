import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real app store over a stubbed browser: what is remembered about where the
 * user was must survive a login the server turns down (the desktop app pairs
 * again by itself and reloads), and must go when the user leaves on purpose.
 */

type Store = typeof import('../src/store/appStore');

let storage: Map<string, string>;
let win: EventTarget & { location: { hash: string; pathname: string; search: string }; history: { replaceState: (...a: unknown[]) => void } };

// The socket is the network: nothing of it is wanted here.
vi.mock('../src/api/socket', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, connected: false };
  return {
    connectSocket: () => socket,
    disconnectSocket: () => undefined,
    getSocket: () => socket,
    emitInterrupt: () => Promise.reject(new Error('offline')),
  };
});

/** A page load: fresh modules over `initial` storage, with the app store initialised. */
async function boot(initial: Record<string, string>): Promise<Store> {
  storage = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const target = new EventTarget() as typeof win;
  // Like a browser: assigning the hash fires hashchange, replaceState does not.
  let hash = '';
  target.location = {
    get hash() {
      return hash;
    },
    set hash(value: string) {
      hash = value;
      target.dispatchEvent(new Event('hashchange'));
    },
    pathname: '/',
    search: '',
  };
  target.history = {
    replaceState: (_state, _title, url) => {
      hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '';
    },
  };
  win = target;
  vi.stubGlobal('window', Object.assign(target, { setTimeout, clearTimeout, innerWidth: 1280, dispatchEvent: target.dispatchEvent.bind(target) }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  // Every request fails: the app stays "connecting", which is all these tests need.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  vi.resetModules();
  const store = await import('../src/store/appStore');
  store.useAppStore.getState().init();
  return store;
}

const SERVERS = JSON.stringify({ servers: [{ id: 'default', name: 'vm', base: '', token: 'jwt' }], activeId: 'default' });
const LEFT_OFF = {
  'agentdeck:servers': SERVERS,
  'agentdeck:route': '#/code',
  'agentdeck:session': 's1',
  'agentdeck:project': 'p1',
  'agentdeck:panes': JSON.stringify({ count: 2, slots: ['t1', 't2'], focus: 1, cleared: [] }),
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where the user was, per server', () => {
  it('starts on the remembered screen when the URL has no hash', async () => {
    const { useAppStore } = await boot(LEFT_OFF);
    expect(useAppStore.getState().route).toEqual({ name: 'code' });
    expect(win.location.hash).toBe('#/code');
    expect(useAppStore.getState().activeProjectId).toBe('p1');
  });

  it('follows the user around: the screen and the open chat are written as they change', async () => {
    const { useAppStore } = await boot(LEFT_OFF);
    useAppStore.getState().navigate({ name: 'git' });
    expect(storage.get('agentdeck:route')).toBe('#/git');
    useAppStore.setState({ activeSessionId: 's2' });
    expect(storage.get('agentdeck:session')).toBe('s2');
    useAppStore.setState({ activeSessionId: null });
    expect(storage.has('agentdeck:session')).toBe(false);
  });
});

describe('a login the server turns down (401)', () => {
  it('keeps screen, chat, project and panes — the desktop app pairs again and reloads', async () => {
    const { useAppStore } = await boot(LEFT_OFF);
    useAppStore.setState({ activeSessionId: 's1', booted: true });
    win.dispatchEvent(new CustomEvent('agentdeck:unauthorized'));

    const st = useAppStore.getState();
    expect(st.token).toBeNull();
    expect(st.booted).toBe(false);
    expect(storage.get('agentdeck:route')).toBe('#/code');
    expect(storage.get('agentdeck:session')).toBe('s1');
    expect(storage.get('agentdeck:project')).toBe('p1');
    expect(storage.get('agentdeck:panes')).toBe(LEFT_OFF['agentdeck:panes']);
    // the pairing screen is up, the page did not move
    expect(st.route).toEqual({ name: 'code' });
    expect(win.location.hash).toBe('#/code');

    // the next page load (after pairing again) is back where it was
    const next = await boot({ ...Object.fromEntries(storage), 'agentdeck:servers': SERVERS });
    expect(next.useAppStore.getState().route).toEqual({ name: 'code' });
    expect(next.useAppStore.getState().activeProjectId).toBe('p1');
  });

  it('does not write the pairing screen over the remembered one while logged out', async () => {
    const { useAppStore } = await boot(LEFT_OFF);
    win.dispatchEvent(new CustomEvent('agentdeck:unauthorized'));
    useAppStore.getState().navigate({ name: 'home' });
    useAppStore.setState({ activeSessionId: null });
    expect(storage.get('agentdeck:route')).toBe('#/code');
    expect(storage.get('agentdeck:session')).toBe('s1');
  });
});

describe('leaving on purpose', () => {
  it('forgets screen, chat and project of that server', async () => {
    const { useAppStore } = await boot(LEFT_OFF);
    useAppStore.setState({ activeSessionId: 's1' });
    useAppStore.getState().unpair();
    expect(storage.has('agentdeck:route')).toBe(false);
    expect(storage.has('agentdeck:session')).toBe(false);
    expect(storage.has('agentdeck:project')).toBe(false);
    expect(useAppStore.getState().route).toEqual({ name: 'home' });
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });
});
