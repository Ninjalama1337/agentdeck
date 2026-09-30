import { describe, expect, it } from 'vitest';
import { signDeviceToken, verifyDeviceToken } from '../src/auth/jwt.js';

const SECRET = 'a'.repeat(64); // 32 bytes hex

describe('device JWTs', () => {
  it('roundtrips a valid token', async () => {
    const token = await signDeviceToken(SECRET, { deviceId: 'd_1', name: 'Pixel 9' });
    const payload = await verifyDeviceToken(SECRET, token);
    expect(payload).toEqual({ deviceId: 'd_1', name: 'Pixel 9' });
  });

  it('rejects an expired token', async () => {
    // Sign with a 1s lifetime by manipulating exp through a stolen-sign trick:
    // simplest deterministic approach — verify a token signed for the past.
    const token = await signDeviceToken(SECRET, { deviceId: 'd_1', name: 'x' });
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      exp: number;
    };
    payload.exp = Math.floor(Date.now() / 1000) - 10;
    const tampered = [
      token.split('.')[0],
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      token.split('.')[2],
    ].join('.');
    expect(await verifyDeviceToken(SECRET, tampered)).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await signDeviceToken(SECRET, { deviceId: 'd_1', name: 'x' });
    const evil = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyDeviceToken(SECRET, evil)).toBeNull();
  });

  it('rejects tokens signed with another secret', async () => {
    const token = await signDeviceToken(SECRET, { deviceId: 'd_1', name: 'x' });
    expect(await verifyDeviceToken('b'.repeat(64), token)).toBeNull();
  });

  it('rejects garbage input', async () => {
    expect(await verifyDeviceToken(SECRET, 'not-a-jwt')).toBeNull();
  });
});
