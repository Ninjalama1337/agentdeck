import { describe, expect, it } from 'vitest';
import { signDownloadToken, verifyDownloadToken } from '../src/auth/downloadTokens.js';

const SECRET = 'c'.repeat(64);

describe('signed download tokens', () => {
  it('roundtrips signature + payload', () => {
    const token = signDownloadToken(SECRET, { projectId: 'p_1', path: 'src/app.ts' });
    const payload = verifyDownloadToken(SECRET, token, { projectId: 'p_1', path: 'src/app.ts' });
    expect(payload).not.toBeNull();
    expect(payload?.projectId).toBe('p_1');
    expect(payload?.path).toBe('src/app.ts');
    expect(typeof payload?.exp).toBe('number');
  });

  it('rejects an expired token', () => {
    const token = signDownloadToken(SECRET, {
      projectId: 'p_1',
      path: 'a.txt',
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    expect(verifyDownloadToken(SECRET, token, { projectId: 'p_1', path: 'a.txt' })).toBeNull();
  });

  it('rejects a different path than expected (auth-scoped)', () => {
    const token = signDownloadToken(SECRET, { projectId: 'p_1', path: 'a.txt' });
    expect(verifyDownloadToken(SECRET, token, { projectId: 'p_1', path: '../etc/passwd' })).toBeNull();
  });

  it('rejects a different project than expected', () => {
    const token = signDownloadToken(SECRET, { projectId: 'p_1', path: 'a.txt' });
    expect(verifyDownloadToken(SECRET, token, { projectId: 'p_2', path: 'a.txt' })).toBeNull();
  });

  it('rejects tampered signatures and bodies', () => {
    const token = signDownloadToken(SECRET, { projectId: 'p_1', path: 'a.txt' });
    const [body, sig] = token.split('.');
    expect(verifyDownloadToken(SECRET, `${body}.${sig.slice(0, -1)}X`, { projectId: 'p_1', path: 'a.txt' })).toBeNull();

    // Re-sign body with wrong secret
    const other = signDownloadToken('d'.repeat(64), { projectId: 'p_1', path: 'a.txt' });
    expect(verifyDownloadToken(SECRET, other, { projectId: 'p_1', path: 'a.txt' })).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyDownloadToken(SECRET, 'garbage', { projectId: 'p', path: 'x' })).toBeNull();
    expect(verifyDownloadToken(SECRET, 'a.b.c', { projectId: 'p', path: 'x' })).toBeNull();
  });
});
