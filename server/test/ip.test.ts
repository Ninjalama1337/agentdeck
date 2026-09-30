import { describe, expect, it } from 'vitest';
import { clientIp, firstForwardedFor, isLoopbackAddress, normalizeIp } from '../src/util/ip.js';

function req(socketIp: string | undefined, xff?: string | string[]) {
  return {
    socket: { remoteAddress: socketIp },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as Parameters<typeof clientIp>[0];
}

describe('normalizeIp / isLoopbackAddress', () => {
  it('strips the IPv4-mapped prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.7')).toBe('192.168.1.7');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp(undefined)).toBe('');
  });

  it('detects loopback in all spellings', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.9.9.9')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.7')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.7')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('firstForwardedFor', () => {
  it('takes the first entry of comma-separated lists', () => {
    expect(firstForwardedFor('203.0.113.9, 70.41.3.18')).toBe('203.0.113.9');
    expect(firstForwardedFor(['203.0.113.9, 70.41.3.18', '1.1.1.1'])).toBe('203.0.113.9');
    expect(firstForwardedFor('  2606:4700::1111 ')).toBe('2606:4700::1111');
    expect(firstForwardedFor(undefined)).toBeUndefined();
    expect(firstForwardedFor('')).toBeUndefined();
  });
});

describe('clientIp', () => {
  it('uses the direct socket IP when no proxy is involved', () => {
    expect(clientIp(req('192.168.1.7'))).toBe('192.168.1.7');
    expect(clientIp(req('::ffff:10.0.0.5'))).toBe('10.0.0.5');
  });

  it('honors x-forwarded-for from a localhost (cloudflared) peer', () => {
    expect(clientIp(req('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('::1', '203.0.113.9, 70.41.3.18'))).toBe('203.0.113.9');
    expect(clientIp(req('::ffff:127.0.0.1', ['203.0.113.9']))).toBe('203.0.113.9');
  });

  it('ignores spoofed x-forwarded-for from non-localhost peers', () => {
    expect(clientIp(req('192.168.1.7', '1.2.3.4'))).toBe('192.168.1.7');
    expect(clientIp(req('10.20.30.40', '1.2.3.4, 5.6.7.8'))).toBe('10.20.30.40');
  });

  it('falls back to the socket IP when xff is missing or empty', () => {
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', ''))).toBe('127.0.0.1');
    expect(clientIp(req(undefined))).toBe('unknown');
  });
});
