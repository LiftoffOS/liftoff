// Work that must finish even though no request is waiting for it.
//
// developer-proxy runs on request-based CPU: between requests the instance has
// no CPU, so a promise left running after its request ends stalls until the
// next request arrives, or until shutdown. Cloud Run allocates CPU for the
// SIGTERM grace period, and the SIGTERM handler (server.ts) awaits
// settleInFlight() before it closes the pool, so tracked work completes on
// one or the other. Untracked work would be cut off by closePool().
//
// Today the only such work is a usage record whose client hung up first: the
// request is over the moment the client disconnects, and the vendor still
// bills the tokens it generated.

const pending = new Set<Promise<unknown>>();

/** Track `work` until it settles; returns it unchanged. */
export function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const forget = (): void => {
    pending.delete(work);
  };
  work.then(forget, forget);
  return work;
}

/** Resolves once every tracked promise has settled, including ones tracked while waiting. */
export async function settleInFlight(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
