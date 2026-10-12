/**
 * At most `max` automatic reloads per `windowMs` — a page that crashes while loading must not
 * reload itself forever.
 */
export function createRestartLimiter(max = 3, windowMs = 60_000): { allow(now: number): boolean } {
  let stamps: number[] = [];
  return {
    allow(now) {
      stamps = stamps.filter((t) => now - t < windowMs);
      if (stamps.length >= max) return false;
      stamps.push(now);
      return true;
    },
  };
}
