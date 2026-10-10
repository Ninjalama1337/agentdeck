import { describe, expect, it } from 'vitest';
import {
  isScreenHash,
  parseHash,
  routeToHash,
  startHash,
  validRoute,
  validSessionId,
  type Route,
} from '../src/store/route';
import { PER_SERVER_KEYS } from '../src/api/servers';

describe('hash router', () => {
  it('round-trips every screen', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'chat' },
      { name: 'code' },
      { name: 'files' },
      { name: 'git' },
      { name: 'settings' },
      { name: 'team', runId: 'run 1/é' },
    ];
    for (const route of routes) expect(parseHash(routeToHash(route))).toEqual(route);
  });

  it('keeps reading the old spellings', () => {
    expect(parseHash('#/github')).toEqual({ name: 'git' });
    expect(parseHash('#chat')).toEqual({ name: 'chat' });
    expect(parseHash('#/chat?x=1')).toEqual({ name: 'chat' });
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/nonsense')).toEqual({ name: 'home' });
    // A run id that is not valid percent-encoding is taken as written.
    expect(parseHash('#/team/100%')).toEqual({ name: 'team', runId: '100%' });
  });
});

describe('what counts as a remembered screen', () => {
  it('accepts screens, rejects home, empties and garbage', () => {
    for (const hash of ['#/chat', '#/code', '#/files', '#/git', '#/github', '#/settings', '#/team/abc']) {
      expect(isScreenHash(hash)).toBe(true);
    }
    for (const hash of ['#/', '#', '', '#/team/', '#/whatever', null, undefined]) {
      expect(isScreenHash(hash)).toBe(false);
    }
  });
});

describe('start screen', () => {
  it('a hash in the URL always wins', () => {
    expect(startHash('#/files', '#/code')).toBe('#/files');
    expect(startHash('#/', '#/code')).toBe('#/');
  });

  it('without a hash the last screen comes back', () => {
    expect(startHash('', '#/code')).toBe('#/code');
    expect(startHash('#', '#/chat')).toBe('#/chat');
    expect(startHash('', '#/team/abc')).toBe('#/team/abc');
  });

  it('falls back to home when nothing usable is remembered', () => {
    expect(startHash('', null)).toBe('#/');
    expect(startHash('', '')).toBe('#/');
    expect(startHash('', '#/whatever')).toBe('#/');
    expect(startHash('', '#/')).toBe('#/');
  });
});

describe('remembered targets that are gone', () => {
  it('a team run that no longer exists falls back to the chat list', () => {
    expect(validRoute({ name: 'team', runId: 'gone' }, { teamRunIds: ['a', 'b'] })).toEqual({ name: 'chat' });
    const kept: Route = { name: 'team', runId: 'a' };
    expect(validRoute(kept, { teamRunIds: ['a'] })).toBe(kept);
  });

  it('other screens stay as they are', () => {
    const code: Route = { name: 'code' };
    expect(validRoute(code, { teamRunIds: [] })).toBe(code);
  });

  it('a chat session is only restored while it exists', () => {
    expect(validSessionId('s2', ['s1', 's2'])).toBe('s2');
    expect(validSessionId('s9', ['s1', 's2'])).toBeNull();
    expect(validSessionId(null, ['s1'])).toBeNull();
    expect(validSessionId('', ['s1'])).toBeNull();
    expect(validSessionId('s1', [])).toBeNull();
  });
});

describe('per-server storage', () => {
  it('lists the keys that remember where the user left off, so removing a server forgets them', () => {
    for (const key of ['agentdeck:route', 'agentdeck:session', 'agentdeck:panes', 'agentdeck:project']) {
      expect(PER_SERVER_KEYS).toContain(key);
    }
  });
});
