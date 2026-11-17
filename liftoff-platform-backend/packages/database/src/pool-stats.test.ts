import type { Pool } from 'pg';
import { collectPoolStats, resolvePoolSize } from './pool-stats.js';

function mockPool(total: number, idle: number, waiting: number): Pool {
  return { totalCount: total, idleCount: idle, waitingCount: waiting } as unknown as Pool;
}

describe('collectPoolStats', () => {
  it('collects stats for each named pool', () => {
    const stats = collectPoolStats([
      ['api', mockPool(5, 3, 0)],
      ['workers', mockPool(10, 8, 1)],
    ]);

    expect(stats).toEqual({
      api: { total: 5, idle: 3, waiting: 0 },
      workers: { total: 10, idle: 8, waiting: 1 },
    });
  });

  it('returns an empty object for empty input', () => {
    expect(collectPoolStats([])).toEqual({});
  });
});

describe('resolvePoolSize', () => {
  const ORIG_ENV = { ...process.env };

  afterEach(() => {
    // Clear any DB_POOL_SIZE* we set during tests.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DB_POOL_SIZE')) delete process.env[key];
    }
    // Restore any that existed before.
    for (const key of Object.keys(ORIG_ENV)) {
      if (key.startsWith('DB_POOL_SIZE')) process.env[key] = ORIG_ENV[key];
    }
  });

  it('reads per-service env override first', () => {
    process.env.DB_POOL_SIZE_TENANT_API = '42';
    expect(
      resolvePoolSize('tenant-api', { defaults: { 'tenant-api': 5, default: 3 } }),
    ).toBe(42);
  });

  it('falls back to global DB_POOL_SIZE', () => {
    process.env.DB_POOL_SIZE = '11';
    expect(resolvePoolSize('api', { defaults: { api: 5, default: 3 } })).toBe(11);
  });

  it('falls back to per-service default when no env set', () => {
    expect(
      resolvePoolSize('api', { defaults: { api: 5, default: 3 } }),
    ).toBe(5);
  });

  it('falls back to `default` when service not in defaults', () => {
    expect(
      resolvePoolSize('unknown', { defaults: { api: 5, default: 3 } }),
    ).toBe(3);
  });

  it('supports custom env prefix', () => {
    process.env.MY_PREFIX_API = '99';
    expect(
      resolvePoolSize('api', {
        defaults: { api: 5, default: 3 },
        envPrefix: 'MY_PREFIX_',
      }),
    ).toBe(99);
  });
});
