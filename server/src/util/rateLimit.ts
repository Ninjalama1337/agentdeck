/**
 * Minimal sliding-window rate limiter keyed by arbitrary strings (client IPs).
 * Used for public, unauthenticated endpoints (e.g. APK downloads).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit for `key`; false when the caller exceeded the budget. */
  allow(key: string): boolean {
    const t = this.now();
    const hits = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (hits.length >= this.max) {
      this.hits.set(key, hits);
      return false;
    }
    hits.push(t);
    this.hits.set(key, hits);
    return true;
  }
}
