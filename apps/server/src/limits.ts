/** The wait queue is full: the instance is busy. */
export class BusyError extends Error {}

/**
 * Runs at most `max` tasks at once; up to `maxQueue` more wait in order and
 * the rest are refused with BusyError. Verification decodes full photos, so
 * this bounds memory. A finishing task hands its slot straight to the next
 * waiter, so no caller can slip in between.
 */
export function createConcurrencyLimit(max: number, maxQueue = max * 8) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= max) {
      if (waiting.length >= maxQueue) throw new BusyError('busy');
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/**
 * In-memory sliding-window limit, keyed after authentication (an install ID),
 * so random tokens cannot each get a fresh budget. Per server instance.
 */
export function createWindowLimit(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  let lastSweep = now();
  return function allow(key: string): boolean {
    const t = now();
    if (t - lastSweep > windowMs) {
      for (const [k, list] of hits) if (list[list.length - 1] <= t - windowMs) hits.delete(k);
      lastSweep = t;
    }
    const list = (hits.get(key) ?? []).filter((at) => at > t - windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(t);
    hits.set(key, list);
    return true;
  };
}
