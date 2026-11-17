// Tiny in-house concurrency limiter — drop-in replacement for `p-limit`.
//
// We avoid the npm `p-limit` package because its v5+ is ESM-only and Jest's
// transformIgnorePatterns dance gets brittle with native ts-jest. The
// canonical p-limit interface is small enough (one function) to copy.
//
// Usage:
//   const limit = pLimit(8);
//   await Promise.all(items.map(item => limit(() => doWork(item))));

export type LimitFunction = <T>(fn: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): LimitFunction {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`pLimit: concurrency must be a positive integer (got ${concurrency})`);
  }

  const queue: Array<() => void> = [];
  let activeCount = 0;

  const next = (): void => {
    activeCount--;
    if (queue.length > 0) {
      const runNext = queue.shift()!;
      runNext();
    }
  };

  const run = async <T>(fn: () => Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void): Promise<void> => {
    activeCount++;
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      next();
    }
  };

  const enqueue = <T>(fn: () => Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void): void => {
    if (activeCount < concurrency) {
      void run(fn, resolve, reject);
    } else {
      queue.push(() => void run(fn, resolve, reject));
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => enqueue(fn, resolve, reject));
}
