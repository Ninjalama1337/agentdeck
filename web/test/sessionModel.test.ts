import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@agentdeck/shared';

const { updateSession } = vi.hoisted(() => ({ updateSession: vi.fn() }));

vi.mock('../src/api/client', () => ({
  api: { updateSession },
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  getApiBase: () => '',
  getToken: () => null,
  setApiBase: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock('../src/api/socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
  emitInterrupt: vi.fn(),
  getSocket: () => null,
}));

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: { hash: '', pathname: '/', search: '', protocol: 'http:' },
    history: { replaceState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    innerWidth: 1200,
  },
});

type AppStore = typeof import('../src/store/appStore').useAppStore;
let useAppStore: AppStore;

const session: Session = {
  id: 's1',
  projectId: 'p1',
  agentId: 'claude',
  title: 'Session',
  status: 'stopped',
  permissionMode: 'default',
  createdAt: 0,
  updatedAt: 0,
};

beforeAll(async () => {
  ({ useAppStore } = await import('../src/store/appStore'));
});

beforeEach(() => {
  updateSession.mockReset();
  useAppStore.setState({ sessionsByProject: { p1: [{ ...session }] }, modelPrefs: {} });
});

describe('setSessionModel', () => {
  it('updates the session model without changing the default for new chats', async () => {
    updateSession.mockResolvedValue(undefined);

    await useAppStore.getState().setSessionModel('s1', 'opencode-go/glm-5.3');

    expect(updateSession).toHaveBeenCalledWith('s1', { model: 'opencode-go/glm-5.3' });
    expect(useAppStore.getState().sessionsByProject.p1?.[0]?.model).toBe('opencode-go/glm-5.3');
    expect(useAppStore.getState().modelPrefs).toEqual({});
  });

  it('rolls the optimistic update back on a failed PATCH', async () => {
    updateSession.mockRejectedValue(new Error('nope'));

    await useAppStore.getState().setSessionModel('s1', 'opencode-go/glm-5.3');

    expect(useAppStore.getState().sessionsByProject.p1?.[0]?.model).toBeUndefined();
    expect(useAppStore.getState().modelPrefs).toEqual({});
  });
});
