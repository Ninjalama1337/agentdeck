/**
 * Rate limiter for pairing attempts: max `max` failures per IP per window.
 * A successful pair clears the IP's history.
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  private hits(ip: string, now: number): number[] {
    const hits = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (hits.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, hits);
    return hits;
  }

  /** True when further attempts from this IP must be rejected. */
  isBlocked(ip: string): boolean {
    return this.hits(ip, Date.now()).length >= this.max;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const hits = this.hits(ip, now);
    hits.push(now);
    this.failures.set(ip, hits);
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}
