// A borrowed pg client can never be allowed to kill the process.
//
// Two halves, and they need different kinds of test.
//
// The guard's own behaviour is asserted against a pool that emits pg-pool's
// events, which is all the guard consumes.
//
// The half that actually decides whether the guard WORKS is a property of
// pg-pool, not of this code: `acquire` has to be emitted BEFORE the pool strips
// its own idle `error` listener, and the idle listener has to be re-attached
// BEFORE `release` is emitted. If either order flipped, this guard would leave a
// window open (or displace the pool's own listener) and nothing in either service
// would fail — the next dropped socket would just exit the container again. So
// the ordering is read out of the INSTALLED pg-pool source, and a version bump
// that reorders it fails the build here.

import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { installBorrowedClientGuard } from './borrowed-client-guard.js';

// ── A pool that speaks pg-pool's events ────────────────────────────────

class FakeClient extends EventEmitter {}

class FakePool extends EventEmitter {
  /** What pg-pool's `_acquireClient` does, in the order it does it. */
  checkout(client: FakeClient, idleListener: (err: Error) => void): void {
    this.emit('acquire', client);
    client.removeListener('error', idleListener);
  }

  /** What `_release` does, in the order it does it. */
  handBack(client: FakeClient, idleListener: (err: Error) => void, err?: Error): void {
    client.on('error', idleListener);
    this.emit('release', err, client);
  }

  discard(client: FakeClient): void {
    this.emit('remove', client);
  }
}

function install(pool: FakePool, logged: Array<Record<string, unknown>>): void {
  installBorrowedClientGuard(pool as unknown as Parameters<typeof installBorrowedClientGuard>[0], {
    logger: { error: (ctx) => { logged.push(ctx); } },
    serviceType: 'probe',
  });
}

/** A client that is idle in the pool: the pool's own listener is attached. */
function idleClient(): { client: FakeClient; idleListener: (err: Error) => void } {
  const client = new FakeClient();
  const idleListener = (): void => { /* the pool's own; never throws */ };
  client.on('error', idleListener);
  return { client, idleListener };
}

describe('a borrowed client never has an unhandled error', () => {
  it('handles an error raised while the client is checked out', () => {
    // The failure, in one assertion. Without the guard this `emit` throws,
    // because the pool removed its own listener on checkout and the borrower
    // never added one — and an unhandled 'error' event exits the process.
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    install(pool, logged);

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);

    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly')))
      .not.toThrow();
    expect(logged).toEqual([{
      event: 'borrowed_client_error',
      serviceType: 'probe',
      err: 'Connection terminated unexpectedly',
    }]);
  });

  it('would throw without the guard, which is what makes the test above mean something', () => {
    // The control. A test that passes for both the guarded and unguarded case
    // proves nothing, and this is the one property worth being certain of.
    const pool = new FakePool();
    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);

    expect(client.listenerCount('error')).toBe(0);
    expect(() => client.emit('error', new Error('boom'))).toThrow('boom');
  });

  it('leaves the pool its own listener back on release, and keeps none of its own', () => {
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    install(pool, logged);

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);
    pool.handBack(client, idleListener);

    // Exactly one: the pool's. Ours is gone, so an idle client is the pool's
    // business again and our log line cannot fire for a connection nobody holds.
    expect(client.listenerCount('error')).toBe(1);
    client.emit('error', new Error('idle drop'));
    expect(logged).toEqual([]);
  });

  it('detaches on remove too, for a client the pool discards rather than returns', () => {
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    install(pool, logged);

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);
    pool.discard(client);

    expect(client.listenerCount('error')).toBe(0);
  });

  it('does not stack listeners across many checkouts of the same client', () => {
    // A pooled client is borrowed thousands of times over an instance's life. A
    // guard that added a listener per checkout would cross Node's
    // MaxListenersExceededWarning threshold and then bury the real signal under
    // its own warning.
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    install(pool, logged);

    const { client, idleListener } = idleClient();
    for (let i = 0; i < 50; i++) {
      pool.checkout(client, idleListener);
      expect(client.listenerCount('error')).toBe(1);
      pool.handBack(client, idleListener);
    }
    expect(client.listenerCount('error')).toBe(1);
  });

  it('does not stack listeners when acquire fires twice without a release', () => {
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    install(pool, logged);

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);
    pool.emit('acquire', client);
    pool.emit('acquire', client);

    expect(client.listenerCount('error')).toBe(1);
    client.emit('error', new Error('once'));
    expect(logged).toHaveLength(1);
  });

  it('keeps each pool to its own clients', () => {
    // The factory hands out one pool per service and the guard is installed per
    // pool. A release on pool B must not strip pool A's listener from a client A
    // still holds.
    const a = new FakePool();
    const b = new FakePool();
    const loggedA: Array<Record<string, unknown>> = [];
    install(a, loggedA);
    install(b, []);

    const { client, idleListener } = idleClient();
    a.checkout(client, idleListener);
    b.emit('release', undefined, client);

    expect(client.listenerCount('error')).toBe(1);
    client.emit('error', new Error('still guarded'));
    expect(loggedA).toHaveLength(1);
  });

  it('works with no logger, because a pool without one must still not crash', () => {
    const pool = new FakePool();
    installBorrowedClientGuard(
      pool as unknown as Parameters<typeof installBorrowedClientGuard>[0],
    );

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);
    expect(() => client.emit('error', new Error('quiet'))).not.toThrow();
  });

  it('omits serviceType from the log line rather than reporting it as undefined', () => {
    const pool = new FakePool();
    const logged: Array<Record<string, unknown>> = [];
    installBorrowedClientGuard(
      pool as unknown as Parameters<typeof installBorrowedClientGuard>[0],
      { logger: { error: (ctx) => { logged.push(ctx); } } },
    );

    const { client, idleListener } = idleClient();
    pool.checkout(client, idleListener);
    client.emit('error', new Error('anonymous'));

    expect(logged[0]).not.toHaveProperty('serviceType');
  });
});

// ── The pg-pool property the whole approach rests on ───────────────────

describe('the installed pg-pool still emits its events where the guard needs them', () => {
  const require = createRequire(__filename);
  const source = readFileSync(require.resolve('pg-pool'), 'utf8');

  /** Index of the first occurrence, asserted present so a rename fails loudly. */
  function at(needle: string): number {
    const i = source.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  }

  it('emits acquire BEFORE stripping its own idle error listener', () => {
    // If this flipped, a client would be listener-less between the strip and our
    // `acquire` handler — a window with no code in it, and no test anywhere else
    // would notice.
    const acquireBlock = at('_acquireClient(client, pendingItem, idleListener, isNew)');
    const emitAcquire = source.indexOf("this.emit('acquire', client)", acquireBlock);
    const strip = source.indexOf("client.removeListener('error', idleListener)", acquireBlock);
    expect(emitAcquire).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(-1);
    expect(emitAcquire).toBeLessThan(strip);
  });

  it('re-attaches its own idle error listener BEFORE emitting release', () => {
    // If this flipped, our `release` handler would remove our listener while the
    // pool had not yet added its own — the same window, on the way back.
    const releaseBlock = at('_release(client, idleListener, err)');
    const reattach = source.indexOf("client.on('error', idleListener)", releaseBlock);
    const emitRelease = source.indexOf("this.emit('release', err, client)", releaseBlock);
    expect(reattach).toBeGreaterThan(-1);
    expect(emitRelease).toBeGreaterThan(-1);
    expect(reattach).toBeLessThan(emitRelease);
  });

  it('still checks out through connect() in callback mode for a query, which is why nothing is wrapped', () => {
    // The reason this module hooks events instead of wrapping `pool.connect`:
    // `query` calls it with a callback and gets `undefined` back, so a wrapper
    // that awaits the result breaks every pool.query() in the service.
    const queryBlock = at('query(text, values, cb)');
    expect(source.indexOf('this.connect((err, client) => {', queryBlock))
      .toBeGreaterThan(queryBlock);
  });

  it('handles a query client\'s errors itself, so pool.query was never the exposed path', () => {
    // Stated because getting this wrong would mean guarding the wrong thing. The
    // exposed borrows are the explicit `pool.connect()` calls.
    const queryBlock = at('query(text, values, cb)');
    expect(source.indexOf("client.once('error', onError)", queryBlock))
      .toBeGreaterThan(queryBlock);
  });
});
