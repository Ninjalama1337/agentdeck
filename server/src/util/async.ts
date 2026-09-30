export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with the promise result or rejects with TimeoutError after `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves with a fallback value if the promise does not settle within `ms`. */
export async function withTimeoutFallback<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  what = 'operation',
): Promise<T> {
  try {
    return await withTimeout(promise, ms, what);
  } catch (err) {
    if (err instanceof TimeoutError) return fallback;
    throw err;
  }
}

/** Repeatedly invokes `fn` until it returns a truthy value or the timeout elapses. */
export async function poll<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T | undefined> {
  const interval = opts.intervalMs ?? 250;
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) return undefined;
    await sleep(interval);
  }
}
