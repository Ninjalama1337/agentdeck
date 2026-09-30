import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/auth/attemptLimiter.js';

describe('AttemptLimiter', () => {
  it('blocks after 5 failures within the window', () => {
    const limiter = new AttemptLimiter(5, 10 * 60 * 1000);
    const ip = '192.168.1.50';
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(false);
    }
    limiter.recordFailure(ip);
    expect(limiter.isBlocked(ip)).toBe(true);
  });

  it('does not leak state between IPs', () => {
    const limiter = new AttemptLimiter(5, 10 * 60 * 1000);
    for (let i = 0; i < 10; i++) limiter.recordFailure('10.0.0.1');
    expect(limiter.isBlocked('10.0.0.1')).toBe(true);
    expect(limiter.isBlocked('10.0.0.2')).toBe(false);
  });

  it('a success clears the IP history', () => {
    const limiter = new AttemptLimiter(5, 10 * 60 * 1000);
    for (let i = 0; i < 5; i++) limiter.recordFailure('10.0.0.3');
    expect(limiter.isBlocked('10.0.0.3')).toBe(true);
    limiter.recordSuccess('10.0.0.3');
    expect(limiter.isBlocked('10.0.0.3')).toBe(false);
  });

  it('expired failures no longer count', () => {
    const limiter = new AttemptLimiter(5, 0); // zero window → everything expires
    limiter.recordFailure('10.0.0.4');
    expect(limiter.isBlocked('10.0.0.4')).toBe(false);
  });
});
