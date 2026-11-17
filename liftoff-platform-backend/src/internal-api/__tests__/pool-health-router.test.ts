import { buildPoolHealthReport } from '../pool-health-router';

describe('buildPoolHealthReport', () => {
  it('is healthy when no client is queued for a connection', () => {
    const report = buildPoolHealthReport({
      default: { total: 12, idle: 3, waiting: 0 },
      admin: { total: 2, idle: 2, waiting: 0 },
    });

    expect(report.healthy).toBe(true);
    expect(report.totalWaiting).toBe(0);
  });

  it('is healthy with a busy pool that has nothing waiting', () => {
    // A high total with zero idle is a warm pool at full stretch, not a fault —
    // only a queue means callers are actually blocked.
    const report = buildPoolHealthReport({ default: { total: 20, idle: 0, waiting: 0 } });

    expect(report.healthy).toBe(true);
  });

  it('is unhealthy as soon as any pool has a waiter', () => {
    const report = buildPoolHealthReport({
      default: { total: 20, idle: 0, waiting: 3 },
      admin: { total: 2, idle: 2, waiting: 0 },
    });

    expect(report.healthy).toBe(false);
    expect(report.totalWaiting).toBe(3);
  });

  it('sums waiters across every pool', () => {
    const report = buildPoolHealthReport({
      default: { total: 20, idle: 0, waiting: 3 },
      admin: { total: 2, idle: 0, waiting: 1 },
      'svc:billing': { total: 5, idle: 0, waiting: 2 },
    });

    expect(report.totalWaiting).toBe(6);
  });

  it('reports healthy when there are no pools yet', () => {
    const report = buildPoolHealthReport({});

    expect(report.healthy).toBe(true);
    expect(report.pools).toEqual({});
  });
});
