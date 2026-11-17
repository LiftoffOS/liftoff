// Polls a function until a predicate returns true or a timeout expires.
// Used by the integration suite to wait for async-propagated state (mapping
// creation, compiled_instruction activation).

export interface PollOpts {
  timeoutMs: number;
  pollIntervalMs: number;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: PollOpts,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
  throw new Error(`pollUntil: predicate not satisfied within ${opts.timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}
