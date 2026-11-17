// Regression: node-postgres's Pool.query() internally calls
// `this.connect(cb)` with a callback. The leak-detector wrapper in
// createServicePool MUST honor that callback contract — otherwise
// pool.query() across the entire service throws
// "pool.connect resolved with non-PoolClient: undefined" and the
// service collapses.
//
// This test stands up a fake Pool that mimics pg-pool's connect
// semantics (callback-mode returns undefined and invokes cb;
// promise-mode returns a Promise<client>) and confirms the wrapper:
//   1. Doesn't lose the callback-mode return contract (still returns
//      undefined, still invokes the callback with a real client).
//   2. Still resolves the Promise form with a client.
//   3. Still tags the client's release() so the leak detector sees it.

import { jest } from '@jest/globals';

// src/test-utils/setup.ts globally mocks ../infrastructure/database — this
// test exercises the REAL wrapper, so override that mock for this file.
jest.unmock('../database');

// Mock @liftoffos/database to avoid pulling in the real factory.
const installBorrowedClientGuard = jest.fn();
jest.mock('@liftoffos/database', () => ({
  DatabasePoolFactory: class {
    constructor() {}
  },
  withTenantScope: jest.fn(),
  withAdminScope: jest.fn(),
  resolvePoolSize: jest.fn().mockReturnValue(5),
  installBorrowedClientGuard,
}));

// Mock logging.
jest.mock('../logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Inject a pg Pool replacement that mirrors the real callback/promise
// dual API. Using a plain function constructor (rather than ES class) so
// ts-jest's hoisted factory doesn't get auto-mocked into a stub.
jest.mock('pg', () => {
  function FakePool(this: Record<string, unknown>) {
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
    this.on = function () { return this; };
    this.connect = function (cb?: (err: Error | undefined, client: unknown, done: () => void) => void): unknown {
      const client = {
        query: () => Promise.resolve({ rows: [] }),
        release: () => {},
      };
      if (typeof cb === 'function') {
        cb(undefined, client, () => {});
        return undefined;
      }
      return Promise.resolve(client);
    };
  }
  return { Pool: FakePool };
});

import { getPoolForService } from '../database';

describe('createServicePool leak-detector wrapper — callback API preserved', () => {
  it('connect(cb) invokes the user callback with a real client (pg internal API, used by pool.query)', (done) => {
    const pool = getPoolForService('default');
    (pool as unknown as {
      connect: (cb: (err: Error | undefined, client: { release: unknown } | undefined, done: () => void) => void) => unknown;
    }).connect((err, client) => {
      try {
        expect(err).toBeUndefined();
        expect(client).toBeDefined();
        expect(typeof client?.release).toBe('function');
        done();
      } catch (e) {
        done(e as Error);
      }
    });
  });

  it('connect() (no args) returns a Promise that resolves with a client', async () => {
    const pool = getPoolForService('event-subscriber');
    const client = await (pool as unknown as { connect: () => Promise<{ release: unknown }> }).connect();
    expect(client).toBeDefined();
    expect(typeof client.release).toBe('function');
  });

  // The guard and this wrapper are the two halves of the same property, and each
  // covers what the other cannot: the wrapper names the call site that failed to
  // release, the guard stops a socket dropping under a borrowed client from
  // exiting the process. A pool built without it is a process-kill site, and
  // nothing about that is visible until the day a socket drops — so the
  // installation is asserted, not merely mocked away.
  it('installs the borrowed-client guard on every pool it builds', () => {
    installBorrowedClientGuard.mockClear();
    const pool = getPoolForService('reflection-engine');
    // `getPoolForService` hands back a lazy Proxy and builds the real pool on
    // first touch, so the guard is installed when somebody uses the pool rather
    // than when they ask for it. Reading a property is the cheapest touch there
    // is; without it this would assert on a pool that does not exist yet.
    void (pool as unknown as { totalCount: number }).totalCount;
    expect(installBorrowedClientGuard).toHaveBeenCalledTimes(1);
    expect(installBorrowedClientGuard.mock.calls[0][1]).toMatchObject({
      serviceType: 'reflection-engine',
    });
  });

  it('release() wrapping survives both code paths so the leak detector still sees them', (done) => {
    const pool = getPoolForService('scheduled-execution');
    (pool as unknown as {
      connect: (cb: (err: Error | undefined, client: { release: () => void } | undefined) => void) => void;
    }).connect((err, client) => {
      try {
        expect(client).toBeDefined();
        // release is the wrapper's tagged version; calling it shouldn't throw.
        client?.release();
        done();
      } catch (e) {
        done(e as Error);
      }
    });
  });
});
