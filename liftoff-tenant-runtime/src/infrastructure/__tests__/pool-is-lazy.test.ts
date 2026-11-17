// FITNESS FUNCTION — a pool is built on first USE, never on import.
//
// Fourteen modules do `const pool = getPoolForService('default')` at the top
// level. That runs during `require`, long before `main()` reaches
// `loadSecretsToEnv()`, and it was survivable only while DB_PASSWORD arrived at
// execve from `--set-secrets` — present before any code ran at all.
//
// Taking that binding away (a variable present at execve sits in
// /proc/1/environ for the life of the process, where any in-container child can
// read it and no code can remove it) made the eager build fatal:
// coordinator-service fails to boot with
//
//   Error: createServicePool(event-subscriber) called before DB_PASSWORD was
//   available
//
// thrown from a `require` chain three modules deep, and the Cloud Run deploy
// fails the health check with "container failed to start and listen on
// PORT=8080" — which names nothing about secrets.
//
// The password check still runs. It runs at first query, which is after boot,
// which is when it can pass.

// The global setup mocks `infrastructure/database` for every suite, which is a
// large part of why nothing caught this: the fourteen module-level
// `getPoolForService` calls never touch the real implementation under test. This
// file needs the real one.
jest.unmock('../database');

import { getPoolForService, closePools } from '../database';

describe('getPoolForService', () => {
  const ORIGINAL = process.env.DB_PASSWORD;

  afterEach(async () => {
    if (ORIGINAL === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = ORIGINAL;
    await closePools().catch(() => undefined);
  });

  it('does not build the pool while the password is still missing', () => {
    // The exact shape of the boot failure: a module-level acquisition running
    // during `require`, before hydration. It must not throw.
    delete process.env.DB_PASSWORD;
    expect(() => getPoolForService('default')).not.toThrow();
  });

  it('is still a usable pool once the secret has been hydrated', () => {
    delete process.env.DB_PASSWORD;
    const pool = getPoolForService('default');

    // Hydration happens here, exactly as loadSecretsToEnv would do it after the
    // module graph is already loaded.
    process.env.DB_PASSWORD = 'hydrated-after-import';

    expect(typeof pool.query).toBe('function');
    expect(typeof pool.connect).toBe('function');
    expect(typeof pool.end).toBe('function');
  });

  it('hands back the same pool for the same service', () => {
    process.env.DB_PASSWORD = 'test_password';
    const a = getPoolForService('default');
    const b = getPoolForService('default');
    // Touch one so the underlying pool is really made, then confirm the second
    // handle reaches it rather than making a second connection pool.
    expect(typeof a.query).toBe('function');
    expect(typeof b.query).toBe('function');
    expect(b.totalCount).toBe(a.totalCount);
  });

  it('still refuses to build one with no password when it is actually used', () => {
    // The guard is not removed, only moved. An empty password bakes into the
    // connection string and every query then fails SASL with "client password
    // must be a string", five minutes of schema polling away from the cause.
    const previousEnv = process.env.NODE_ENV;
    delete process.env.DB_PASSWORD;
    process.env.NODE_ENV = 'production';
    const pool = getPoolForService('reflection');
    expect(() => pool.query).toThrow(/DB_PASSWORD was not available|DB_PASSWORD/);
    process.env.NODE_ENV = previousEnv;
  });
});
