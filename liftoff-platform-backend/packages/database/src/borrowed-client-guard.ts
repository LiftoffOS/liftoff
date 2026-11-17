// A borrowed pg client can never be allowed to kill the process.
//
// THE WINDOW. pg-pool attaches its own `error` listener to an IDLE client and
// REMOVES it the moment the client is checked out (`_acquireClient`, index.js:344
// in pg-pool 3.x). From that instant until release the client has no listener at
// all, and in Node an `error` event with no listener is thrown: on Cloud Run that
// is `Container called exit(1)`, taking every in-flight request and every cron on
// the instance with it.
//
// Every Postgres socket on an instance can close at once even while Cloud SQL is
// healthy, no SIGTERM has been sent and nothing is draining. `Connection
// terminated unexpectedly` then lands on a checked-out client and the container
// exits. An `.on('error')` handler on the POOL fires for idle clients only, so
// it covers no explicit borrow — each borrow is a process-kill site, and one that
// fires mid-turn can also leave a chat-turn lock behind that wedges a
// conversation for twenty minutes.
//
// WHICH BORROWS WERE EXPOSED, precisely, because attributing this wrongly is how
// the wrong thing gets guarded: the ~21 explicit `pool.connect()` sites (18 in
// platform-backend's src/ plus the two in this package's tenant scope). NOT
// `pool.query()` — pg-pool puts its own `client.once('error', …)` on the client
// it checks out for a query (index.js:463), so that path was always handled, and
// it releases with the error and rejects the caller. This guard is additive
// there: two listeners fire, ours logs and theirs releases, and it neither
// displaces nor double-releases anything.
//
// WHY EVENTS AND NOT A WRAPPER. `pool.query()` calls `this.connect(cb)` in
// CALLBACK mode (index.js:448), which returns `undefined`. A guard that wraps
// `pool.connect`, awaits it and touches the result therefore throws on every
// `pool.query()` in the service — exactly the regression the tenant runtime
// records at `src/infrastructure/database.ts`, and the
// reason platform-backend's connect wrappers log `pool.connect resolved with
// non-client (passthrough)` continuously. The pool's `acquire` / `release` /
// `remove` events fire for promise-mode `connect()`, callback-mode
// `connect(cb)` and `pool.query()`'s internal checkout alike, so nothing has to
// be wrapped and nothing has to guess which calling convention it is looking at.
//
// THE ORDERING IS SAFE IN BOTH DIRECTIONS, and this is what makes the approach
// correct rather than merely convenient. Both facts are asserted against the
// installed pg-pool in borrowed-client-guard.test.ts, so a version bump that
// reordered either one fails the build rather than silently reopening the window:
//
//   `_acquireClient` emits `acquire` (:340) BEFORE it strips the pool's own idle
//   listener (:344)        — the client is never listener-less on the way out;
//   `_release` re-attaches the idle listener (:385) BEFORE it emits `release`
//   (:389)                 — the client is never listener-less on the way back,
//                            and our guard never displaces the pool's own.
//
// WHAT IT DOES NOT DO. It does not retry, reconnect, or swallow the failure from
// the caller: the borrowed client is dead either way and whatever statement was
// in flight still rejects, which the caller's own error handling already covers.
// The only thing it changes is that ONE failed query stops being a process
// fault — which was never a property anybody chose, only one nobody had
// implemented.

import type { Pool, PoolClient } from 'pg';

/** The subset of a logger this module needs. Same shape as pool-factory's. */
export type BorrowedClientGuardLogger = {
  error: (ctx: Record<string, unknown>, msg: string) => void;
};

export interface BorrowedClientGuardOptions {
  logger?: BorrowedClientGuardLogger;
  /** Names the pool in the log line — 'default', 'admin', a ServiceType. */
  serviceType?: string;
}

/**
 * Keep a checked-out client's `error` event handled for as long as it is
 * borrowed.
 *
 * Call once per pool, at construction. Idempotent per client: a client
 * re-acquired without an intervening `release` (or a pool that emits `acquire`
 * more than once for one checkout) must not stack listeners, or a long-lived
 * pool accumulates them until Node warns about a leak and the warning buries the
 * signal.
 */
export function installBorrowedClientGuard(
  pool: Pool,
  options: BorrowedClientGuardOptions = {},
): void {
  const { logger, serviceType } = options;

  // Keyed on the client, and weak so a client the pool has discarded is not
  // held alive by our bookkeeping.
  const guards = new WeakMap<PoolClient, (err: Error) => void>();

  pool.on('acquire', (client: PoolClient) => {
    if (guards.has(client)) return;
    const onError = (err: Error): void => {
      // Logged and no more. The statement in flight rejects on its own and the
      // pool destroys the client; the only thing this listener exists to
      // prevent is the throw.
      logger?.error(
        {
          event: 'borrowed_client_error',
          ...(serviceType !== undefined ? { serviceType } : {}),
          err: err.message,
        },
        'A borrowed database client errored. Handled here so one failed connection is not a process fault: pg-pool removes its own error listener while a client is checked out.',
      );
    };
    guards.set(client, onError);
    client.on('error', onError);
  });

  const detach = (client: PoolClient | undefined): void => {
    if (!client) return;
    const onError = guards.get(client);
    if (!onError) return;
    client.removeListener('error', onError);
    guards.delete(client);
  };

  // `release` hands back a client the pool has already re-armed with its own
  // idle listener, so ours is redundant from here; `remove` is a client the pool
  // is discarding, which needs no listener at all.
  pool.on('release', (_err: Error | undefined, client: PoolClient) => detach(client));
  pool.on('remove', (client: PoolClient) => detach(client));
}
