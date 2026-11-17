// Cloud Monitoring label-set consistency for drift_count emissions.
//
// Cloud Monitoring auto-creates a metric descriptor from the FIRST emission's
// label keys. If subsequent emissions use a different label key set, the
// descriptor mismatch can cause silent drop or INVALID_ARGUMENT. This test
// asserts every emission of drift_count uses the SAME label keys (drift_type,
// tenant_id, scope) so the schema is stable regardless of emission ordering.

import type { PoolClient } from 'pg';

const writeCustomMetricSpy = jest.fn(async () => undefined);

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (/FROM tenants t\s+JOIN entitlements e/i.test(sql)) {
          return {
            rows: [
              { id: 'tenant-a', runtime_url: 'https://r-a.example' },
              { id: 'tenant-b', runtime_url: 'https://r-b.example' },
            ],
          };
        }
        if (/SELECT \* FROM internal_agents WHERE tenant_id = \$1/i.test(sql)) {
          return { rows: [] }; // No PB agents — clean global aggregate
        }
        if (/INSERT INTO orphan_observations/i.test(sql)) {
          return { rows: [{ first_seen_at: new Date(), republished: false }] };
        }
        if (/DELETE FROM orphan_observations/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return fn(client as unknown as PoolClient);
  }),
}));

jest.mock('../../infrastructure/oidc-fetch', () => ({
  fetchWithOidc: jest.fn(async () => ({
    ok: true,
    json: async () => [], // No orphans
  } as Response)),
}));

jest.mock('../../infrastructure/monitoring', () => ({
  writeCustomMetric: jest.fn((...args: unknown[]) => writeCustomMetricSpy(...args)),
}));

jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: jest.fn(),
  publishOutboxRowInline: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

import { runReconciliation } from '../reconciler';

beforeEach(() => {
  writeCustomMetricSpy.mockClear();
});

describe('drift_count metric label-set stability', () => {
  it('REGRESSION: every drift_count emission uses the same label keys (drift_type, tenant_id, scope)', async () => {
    await runReconciliation({ dryRun: false });

    const driftCountCalls = writeCustomMetricSpy.mock.calls.filter(
      (call) => (call[0] as { metricType: string }).metricType === 'custom.googleapis.com/liftoff/internal_agents/drift_count',
    );
    expect(driftCountCalls.length).toBeGreaterThan(0);

    // Canonical label key set. Every emission MUST match.
    const expectedKeys = ['drift_type', 'scope', 'tenant_id'].sort();

    for (const call of driftCountCalls) {
      const labels = (call[0] as { labels: Record<string, string> }).labels;
      const actualKeys = Object.keys(labels).sort();
      expect(actualKeys).toEqual(expectedKeys);
      // tenant_id must be present (possibly empty for global aggregate)
      expect(labels).toHaveProperty('tenant_id');
    }

    // Sanity: we emitted both per_tenant and global series.
    const scopes = new Set(driftCountCalls.map((call) =>
      (call[0] as { labels: Record<string, string> }).labels.scope,
    ));
    expect(scopes).toContain('per_tenant');
    expect(scopes).toContain('global');
  });
});
