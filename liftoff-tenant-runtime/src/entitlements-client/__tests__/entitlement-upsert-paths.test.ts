// The two cached_entitlements write paths have DIFFERENT ordering semantics,
// and conflating them is what froze the runtime's entitlement cache for four
// months.
//
// An EVENT can arrive out of order, so it must lose to a newer stored snapshot:
// `WHERE cached_entitlements.entity_version < EXCLUDED.entity_version`.
//
// A FETCH is a read of the control plane made a moment ago. It cannot be stale
// relative to itself, so there is nothing to order it against. When the same
// guard was applied to it, and the control plane served the same
// `entity_version` on every read, the UPDATE matched zero rows on every call —
// the fetch logged "fetched and cached" while writing nothing, `updated_at`
// never moved, and `isCacheStale` was therefore true forever.

import { EntitlementsRepository } from '../repository';
import { getPool } from '../../infrastructure/database';
import type { TenantEntitlement } from '../types';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
(getPool as jest.Mock).mockReturnValue({ query: mockQuery });

function entitlement(overrides: Partial<TenantEntitlement> = {}): TenantEntitlement {
  return {
    tenantId: 'tenant-test-456',
    operationalStatus: 'active',
    agentExecutionAllowed: true,
    billingSuspended: false,
    remainingIncludedCredits: 4000,
    overageAllowed: true,
    includedMonthlyCredits: 10000,
    overageCeiling: 1000000,
    entityVersion: 1,
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

/** Collapse whitespace so assertions read against the SQL, not its layout. */
function sqlOf(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, ' ').trim();
}

describe('cached_entitlements upsert paths', () => {
  let repo: EntitlementsRepository;

  beforeEach(() => {
    mockQuery.mockClear();
    repo = new EntitlementsRepository();
  });

  describe('fetch path', () => {
    it('writes with NO version guard, so an equal entity_version still lands', async () => {
      await repo.upsertEntitlementFromFetch(entitlement({ entityVersion: 1 }));

      const sql = sqlOf(mockQuery.mock.calls[0]);
      expect(sql).toContain('ON CONFLICT (tenant_id) DO UPDATE SET');
      expect(sql).not.toContain('entity_version < EXCLUDED.entity_version');
    });

    it('always advances updated_at, which is what makes isCacheStale mean anything', async () => {
      await repo.upsertEntitlementFromFetch(entitlement());

      const sql = sqlOf(mockQuery.mock.calls[0]);
      // Present in the DO UPDATE clause, not only in the INSERT column list.
      expect(sql).toContain('updated_at = NOW()');
    });

    it('carries billing_suspended, the control plane hard stop', async () => {
      await repo.upsertEntitlementFromFetch(entitlement({ billingSuspended: true }));

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ')).toContain('billing_suspended = EXCLUDED.billing_suspended');
      expect(params).toContain(true);
    });
  });

  describe('event path', () => {
    it('keeps the version guard so an older event cannot clobber a newer row', async () => {
      await repo.upsertEntitlementFromEvent(entitlement({ entityVersion: 7 }));

      const sql = sqlOf(mockQuery.mock.calls[0]);
      expect(sql).toContain('WHERE cached_entitlements.entity_version < EXCLUDED.entity_version');
    });
  });

  it('the two paths differ ONLY by that guard', async () => {
    await repo.upsertEntitlementFromFetch(entitlement());
    await repo.upsertEntitlementFromEvent(entitlement());

    const fetchSql = sqlOf(mockQuery.mock.calls[0]);
    const eventSql = sqlOf(mockQuery.mock.calls[1]);
    expect(eventSql).toBe(`${fetchSql} WHERE cached_entitlements.entity_version < EXCLUDED.entity_version`);

    // Same columns, same order, same values — the shared statement body is not
    // duplicated, so the two cannot drift apart.
    expect(mockQuery.mock.calls[0][1]).toEqual(mockQuery.mock.calls[1][1]);
  });
});
