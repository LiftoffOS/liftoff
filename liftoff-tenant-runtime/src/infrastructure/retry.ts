export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < opts.attempts - 1) {
        const delay = Math.min(opts.baseDelayMs * 2 ** i, opts.maxDelayMs);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
