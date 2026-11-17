// AccountService.cascadeDelete + reprovision unit tests.
// Mocks withAdminScope, Stripe, Firebase, AccountRepository.

const mockAdminQuery = jest.fn();
const mockAccountFindById = jest.fn();
const mockAccountUpdateStripe = jest.fn();
const mockInsertDeletionLedger = jest.fn();
const mockTenantFindByAccountId = jest.fn();
const mockTenantMembersFindOwnedTenantIds = jest.fn().mockResolvedValue([]);
const mockTenantActivate = jest.fn();
const mockTenantGetById = jest.fn();
const mockStripeCreate = jest.fn();
const mockStripeDelete = jest.fn();
const mockStripeUpdate = jest.fn();
const mockStripeSearch = jest.fn();
const mockFirebaseDeleteUser = jest.fn();
const mockFirebaseRevokeTokens = jest.fn();
const mockPublishEvent = jest.fn();
const mockPublishEventInTx = jest.fn().mockResolvedValue({ id: 'evt-test', entityType: 'tenant', entityId: 'test' });
const mockListConnectorsForTenant = jest.fn().mockResolvedValue([]);
const mockDeleteConnectorForTenant = jest.fn().mockResolvedValue(undefined);
const mockScrubCustomer = jest.fn();

jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockAdminQuery }),
  ),
  getPool: jest.fn(() => ({
    query: jest.fn(),
    connect: jest.fn(),
  })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('./repository', () => ({
  AccountRepository: jest.fn().mockImplementation(() => ({
    findById: mockAccountFindById,
    updateStripeCustomerId: mockAccountUpdateStripe,
    insertDeletionLedger: mockInsertDeletionLedger,
  })),
}));

jest.mock('../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    findByAccountId: mockTenantFindByAccountId,
  })),
}));

jest.mock('../tenant-members/repository', () => ({
  TenantMembersRepository: jest.fn().mockImplementation(() => ({
    findOwnedTenantIds: mockTenantMembersFindOwnedTenantIds,
  })),
}));

jest.mock('../tenants/service', () => ({
  TenantService: jest.fn().mockImplementation(() => ({
    activate: mockTenantActivate,
    getById: mockTenantGetById,
  })),
}));

jest.mock('../events/publisher', () => ({
  publishEvent: mockPublishEvent,
  // The cascadeDelete post-Phase-3 wraps the account-row DELETE in
  // mutateAndPublishEvent so an account.deleted outbox row commits with the
  // delete. The mock invokes the callback with the admin query mock so the
  // existing tests' DELETE-account-row assertion still works.
  mutateAndPublishEvent: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<{ entity: unknown }>) => {
    const result = await fn({ query: mockAdminQuery });
    return result.entity;
  }),
  // Web-capabilities Phase 2.8: cascadeDelete enqueues `tenant.deleted` events
  // transactionally via publishEventInTx for each owned tenant. The test
  // mock is a no-op so the cascade flow returns normally.
  publishEventInTx: mockPublishEventInTx,
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    customers: {
      create: mockStripeCreate,
      del: mockStripeDelete,
      update: mockStripeUpdate,
      search: mockStripeSearch,
    },
  }));
});

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(() => ({
    deleteUser: mockFirebaseDeleteUser,
    revokeRefreshTokens: mockFirebaseRevokeTokens,
  })),
}));

jest.mock('../infrastructure/firebase', () => ({
  isFirebaseInitialized: jest.fn(() => true),
  initFirebase: jest.fn(async () => undefined),
}));

jest.mock('../connectors/connector-service-client', () => ({
  listConnectorsForTenant: mockListConnectorsForTenant,
  deleteConnectorForTenant: mockDeleteConnectorForTenant,
}));

jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({
    scrubCustomer: mockScrubCustomer,
  })),
}));

import { AccountService } from './service';

describe('AccountService.cascadeDelete', () => {
  let service: AccountService;
  const accountId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AccountService();
  });

  describe('dryRun=true', () => {
    it('returns counts via read-only SELECTs (no inner tx control; wrapper owns BEGIN/COMMIT)', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });

      // Mock the withAdminScope client query sequence (no BEGIN/COMMIT/ROLLBACK
      // inside the callback — the wrapper owns the tx). Sequence after F12:
      //   1. SELECT owned tenants
      //   2. [per-tenant cleanup — empty here, no rows]
      //   3. COUNT cross-tenant tenant_members
      //   4. SELECT pg_constraint FK refs (empty here → no per-FK queries)
      //   5. SELECT COUNT tenants.account_id = $1 (creator orphans = 0)
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // COUNT cross-tenant tenant_members
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // SELECT COUNT creator orphans

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: true });

      expect(summary.dryRun).toBe(true);
      expect(summary.stripeCustomerDeleted).toBe(false);
      expect(summary.firebaseUserDeleted).toBe(false);
      expect(summary.accountRowDeleted).toBe(false);
      expect(mockStripeDelete).not.toHaveBeenCalled();
      expect(mockFirebaseDeleteUser).not.toHaveBeenCalled();

      // The service callback must NOT issue its own BEGIN/COMMIT/ROLLBACK —
      // those are owned by withAdminScope. Dry-run path is reads-only so the
      // wrapper's COMMIT is harmless.
      const txControlCalls = mockAdminQuery.mock.calls.filter(
        (c) => c[0] === 'BEGIN' || c[0] === 'COMMIT' || c[0] === 'ROLLBACK',
      );
      expect(txControlCalls).toEqual([]);
    });

    it('skips Stripe + Firebase calls entirely in dry-run', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] });

      await service.cascadeDelete(accountId, 'admin-1', { dryRun: true });

      expect(mockStripeDelete).not.toHaveBeenCalled();
      expect(mockFirebaseDeleteUser).not.toHaveBeenCalled();
    });
  });

  describe('dryRun=false (real cascade)', () => {
    it('deletes account row LAST (after Stripe + Firebase both succeed)', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });

      // DB tx for tenant data + cross-tenant memberships + FK sweep (no inner
      // BEGIN/COMMIT; wrapper owns the tx). No account row delete inside this
      // scope. Sequence after F12:
      //   SELECT owned → DELETE cross-tenant → SELECT FK refs → SELECT creator orphans
      // Then a separate withAdminScope wrapper runs the account row DELETE.
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rowCount: 0 })       // DELETE tenant_members cross-tenant
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // SELECT COUNT creator orphans
        // Then separate withAdminScope for account row delete
        .mockResolvedValueOnce({ rowCount: 1 });      // DELETE FROM accounts

      mockStripeDelete.mockResolvedValueOnce({});
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      expect(summary.stripeCustomerDeleted).toBe(true);
      expect(summary.firebaseUserDeleted).toBe(true);
      expect(summary.accountRowDeleted).toBe(true);

      // Verify the account row DELETE actually came AFTER both Stripe + Firebase
      // via Jest's invocationCallOrder. This counter is GLOBAL across all jest
      // mock functions (not per-mock), so comparing values from different mocks
      // (mockAdminQuery vs mockStripeDelete vs mockFirebaseDeleteUser) is
      // well-defined: every mock invocation, regardless of which mock, gets a
      // strictly-increasing integer. The implementation guarantees order via
      // sequential await; the test enforces the contract so a future refactor
      // that moves the account delete earlier fails loudly here.
      //
      // Considered a shared call-log array as an alternative (push a tagged
      // entry from each mock impl) but it adds fixture wiring without making
      // the ordering assertion any clearer — invocationCallOrder is the right
      // tool for "did mock A fire before mock B?" across mocks.
      const accountDeleteIdx = mockAdminQuery.mock.calls.findIndex(
        (c) => typeof c[0] === 'string' && c[0].includes('DELETE FROM accounts WHERE id'),
      );
      expect(accountDeleteIdx).toBeGreaterThanOrEqual(0);
      const accountDeleteOrder = mockAdminQuery.mock.invocationCallOrder[accountDeleteIdx];
      const stripeDeleteOrder = mockStripeDelete.mock.invocationCallOrder[0];
      const firebaseDeleteOrder = mockFirebaseDeleteUser.mock.invocationCallOrder[0];

      expect(stripeDeleteOrder).toBeDefined();
      expect(firebaseDeleteOrder).toBeDefined();
      expect(accountDeleteOrder).toBeGreaterThan(stripeDeleteOrder);
      expect(accountDeleteOrder).toBeGreaterThan(firebaseDeleteOrder);
    });

    it('preserves account row if Stripe delete fails', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });

      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rowCount: 0 })       // DELETE tenant_members cross-tenant
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // SELECT COUNT creator orphans

      mockStripeDelete.mockRejectedValueOnce(new Error('Stripe API down'));
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      expect(summary.stripeCustomerDeleted).toBe(false);
      expect(summary.firebaseUserDeleted).toBe(true);
      expect(summary.accountRowDeleted).toBe(false); // preserved for retry

      // No DELETE FROM accounts call should have happened.
      const deleteAccountCall = mockAdminQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('DELETE FROM accounts WHERE id'),
      );
      expect(deleteAccountCall).toBeUndefined();
    });

    it('preserves account row if Firebase delete fails', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rowCount: 0 })       // DELETE tenant_members cross-tenant
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // SELECT COUNT creator orphans

      mockStripeDelete.mockResolvedValueOnce({});
      mockFirebaseDeleteUser.mockRejectedValueOnce(new Error('Firebase API down'));

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      expect(summary.accountRowDeleted).toBe(false);
    });

    it('treats no-Stripe-customer + no-Firebase-uid as success', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: null,
        stripeCustomerId: null,
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rowCount: 0 })       // DELETE tenant_members cross-tenant
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // SELECT COUNT creator orphans
        .mockResolvedValueOnce({ rowCount: 1 });      // account delete

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      expect(summary.stripeCustomerDeleted).toBe(true);
      expect(summary.firebaseUserDeleted).toBe(true);
      expect(summary.accountRowDeleted).toBe(true);
      expect(mockStripeDelete).not.toHaveBeenCalled();
      expect(mockFirebaseDeleteUser).not.toHaveBeenCalled();
    });

    it('throws AccountNotFoundError when account is missing', async () => {
      mockAccountFindById.mockResolvedValueOnce(null);
      await expect(service.cascadeDelete(accountId, 'admin-1', { dryRun: false }))
        .rejects.toMatchObject({ name: 'AccountNotFoundError', accountId });
    });
  });

  describe('scrubMode: soft (user-initiated)', () => {
    beforeEach(() => {
      mockTenantMembersFindOwnedTenantIds.mockReset().mockResolvedValue([]);
    });

    it('strips Stripe PII via billing scrub, writes deletion ledger, keeps customer alive', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'User+Delete@Example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT owned tenants
        .mockResolvedValueOnce({ rowCount: 0 })       // DELETE tenant_members cross-tenant
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // SELECT COUNT creator orphans
        .mockResolvedValueOnce({ rowCount: 1 });      // DELETE FROM accounts (in mutateAndPublishEvent)
      mockScrubCustomer.mockResolvedValueOnce({ fingerprintsMarked: 1, paymentMethodsDeleted: 0, subsCancelled: 0 });
      mockInsertDeletionLedger.mockResolvedValueOnce({ id: 'led-1' });
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);
      mockFirebaseRevokeTokens.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, accountId, { dryRun: false, scrubMode: 'soft', actorIsAccount: true });

      expect(mockScrubCustomer).toHaveBeenCalledWith('cus_xyz', expect.objectContaining({
        emailHash: expect.any(String),
        accountId,
        tenantIds: expect.any(Array),
      }));
      expect(mockStripeDelete).not.toHaveBeenCalled();
      expect(mockInsertDeletionLedger).toHaveBeenCalled();
      expect(summary.stripeCustomerScrubbed).toBe(true);
      expect(summary.stripeCustomerDeleted).toBe(false);
      expect(summary.deletionLedgerRowId).toBe('led-1');
      expect(summary.accountRowDeleted).toBe(true);
    });

    it('preserves account row when billing scrub fails', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] })          // SELECT FK refs (empty)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // SELECT COUNT creator orphans
      mockScrubCustomer.mockRejectedValueOnce(new Error('billing down'));
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, accountId, { dryRun: false, scrubMode: 'soft', actorIsAccount: true });

      expect(summary.stripeCustomerScrubbed).toBe(false);
      expect(summary.accountRowDeleted).toBe(false);
      expect(mockInsertDeletionLedger).not.toHaveBeenCalled();
    });

    it('fires connector enumeration + revoke for each owned tenant', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockListConnectorsForTenant
        .mockResolvedValueOnce([{ id: 'conn-a' }])
        .mockResolvedValueOnce([{ id: 'conn-b' }, { id: 'conn-c' }]);
      // Owned tenants come from the withAdminScope inner query — capturedOwnedTenantIds
      // is populated from this rows[]. Sequence: owned-tenants SELECT → per-tenant
      // computeTenantTableOrder + UPDATE demote + countOrDeleteTenantData (mostly
      // returning empty), then cross-tenant DELETE, then account row DELETE wrapped
      // in mutateAndPublishEvent. The mock just returns benign shapes so any leftover
      // queries (e.g. catalog enumeration in computeTenantTableOrder) get sane defaults.
      mockAdminQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT DISTINCT t.id')) {
          return Promise.resolve({ rows: [{ id: 'tenant-1' }, { id: 'tenant-2' }] });
        }
        if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('pg_inherits')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('DELETE FROM tenants')) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (typeof sql === 'string' && sql.includes('DELETE FROM accounts')) {
          return Promise.resolve({ rowCount: 1 });
        }
        // F12: FK sweep SELECT pg_constraint — return empty so loop is no-op
        if (typeof sql === 'string' && sql.includes('pg_constraint') && sql.includes('confdeltype')) {
          return Promise.resolve({ rows: [] });
        }
        // F12: creator-orphan check — return 0 so the throw branch is skipped
        if (typeof sql === 'string' && sql.includes('FROM tenants WHERE account_id')) {
          return Promise.resolve({ rows: [{ n: 0 }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      mockScrubCustomer.mockResolvedValueOnce({ fingerprintsMarked: 0, paymentMethodsDeleted: 0, subsCancelled: 0 });
      mockInsertDeletionLedger.mockResolvedValueOnce({ id: 'led-2' });
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, accountId, { dryRun: false, scrubMode: 'soft', actorIsAccount: true });

      expect(mockListConnectorsForTenant).toHaveBeenCalledWith('tenant-1', accountId);
      expect(mockListConnectorsForTenant).toHaveBeenCalledWith('tenant-2', accountId);
      expect(mockDeleteConnectorForTenant).toHaveBeenCalledTimes(3);
      expect(summary.connectorsRevoked).toBe(3);
    });

    // Regression: control_plane_outbox.tenant_id has FK tenants(id) ON DELETE
    // CASCADE. Enqueuing tenant.deleted with tenantId=t.id produces a
    // 23503 FK violation (the tenants row is gone by the time the
    // outbox insert runs). The fix: pass tenantId=null and surface the tenant
    // uuid via entity_id (and the payload) instead.
    it('enqueues tenant.deleted with tenantId=null so the outbox insert does not violate the FK', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT DISTINCT t.id')) {
          return Promise.resolve({ rows: [{ id: 'tenant-1' }] });
        }
        if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('pg_inherits')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('pg_constraint') && sql.includes('confdeltype')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('FROM tenants WHERE account_id')) {
          return Promise.resolve({ rows: [{ n: 0 }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      mockStripeDelete.mockResolvedValueOnce({});
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      const tenantDeletedCall = mockPublishEventInTx.mock.calls.find(
        ([, input]) => input?.eventType === 'tenant.deleted',
      );
      expect(tenantDeletedCall).toBeDefined();
      const input = tenantDeletedCall![1];
      expect(input.tenantId).toBeNull();
      expect(input.entityId).toBe('tenant-1');
      expect(input.payload).toMatchObject({ tenantId: 'tenant-1' });
    });

    // F12 regression: every NO-ACTION/RESTRICT FK referencing accounts(id)
    // would otherwise block the final `DELETE FROM accounts` with a 23503.
    // The sweep DELETEs NOT NULL FK rows and SET NULLs nullable FK columns,
    // discovered dynamically from pg_constraint so future FK additions don't
    // require re-tuning the cascade.
    it('DELETEs rows for NOT NULL FK columns and SET-NULLs for nullable FK columns', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT DISTINCT t.id')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('pg_constraint') && sql.includes('confdeltype')) {
          return Promise.resolve({
            rows: [
              { table_name: 'subscriptions',  column_name: 'account_id', is_nullable: false },
              { table_name: 'billing_controls', column_name: 'account_id', is_nullable: false },
              { table_name: 'tenant_invitations', column_name: 'invited_by', is_nullable: true },
              { table_name: 'admin_action_audit', column_name: 'admin_id',  is_nullable: true },
              // tenants.account_id should be skipped by the special case
              { table_name: 'tenants', column_name: 'account_id', is_nullable: false },
            ],
          });
        }
        if (typeof sql === 'string' && sql.includes('FROM tenants WHERE account_id')) {
          return Promise.resolve({ rows: [{ n: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('DELETE FROM accounts')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      mockStripeDelete.mockResolvedValueOnce({});
      mockFirebaseDeleteUser.mockResolvedValueOnce(undefined);

      const summary = await service.cascadeDelete(accountId, 'admin-1', { dryRun: false });

      const calls = mockAdminQuery.mock.calls.map((c) => c[0] as string).filter((s) => typeof s === 'string');

      // NOT NULL FKs → DELETE
      expect(calls).toContainEqual(expect.stringMatching(/DELETE FROM "subscriptions" WHERE "account_id"/));
      expect(calls).toContainEqual(expect.stringMatching(/DELETE FROM "billing_controls" WHERE "account_id"/));
      // NULLABLE FKs → UPDATE SET NULL (keep the row, anonymize the actor)
      expect(calls).toContainEqual(expect.stringMatching(/UPDATE "tenant_invitations" SET "invited_by" = NULL/));
      expect(calls).toContainEqual(expect.stringMatching(/UPDATE "admin_action_audit" SET "admin_id" = NULL/));
      // tenants.account_id is the special-case skip — must NOT DELETE FROM tenants here
      expect(calls.some((s) => /DELETE FROM "tenants" WHERE "account_id"/.test(s))).toBe(false);

      expect(summary.fkSweepCounts).toMatchObject({
        'subscriptions.account_id': expect.any(Number),
        'billing_controls.account_id': expect.any(Number),
        'tenant_invitations.invited_by': expect.any(Number),
        'admin_action_audit.admin_id': expect.any(Number),
      });
      expect(summary.fkSweepCounts['tenants.account_id']).toBeUndefined();
    });

    // F12: if tenants.account_id still has surviving rows after the per-tenant
    // loop, this account created tenants currently owned by someone else.
    // Deleting them would wipe an innocent workspace. Throw instead, so the
    // operator transfers creator metadata manually first.
    it('throws when tenants.account_id has surviving (transferred) rows', async () => {
      mockAccountFindById.mockResolvedValueOnce({
        id: accountId,
        firebaseUid: 'fb-uid',
        stripeCustomerId: 'cus_xyz',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });
      mockAdminQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT DISTINCT t.id')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('pg_constraint') && sql.includes('confdeltype')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('FROM tenants WHERE account_id')) {
          return Promise.resolve({ rows: [{ n: 2 }] });  // 2 transferred workspaces still point back
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(service.cascadeDelete(accountId, 'admin-1', { dryRun: false }))
        .rejects.toThrow(/creator.*tenants\.account_id.*2 tenant/);
    });
  });
});

describe('AccountService.reprovision', () => {
  let service: AccountService;
  const accountId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AccountService();
  });

  it('creates a Stripe customer when accounts.stripe_customer_id is NULL', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: null,
      email: 'person@example.com',
      firstName: 'Chi',
      lastName: 'Chao',
    });
    mockStripeCreate.mockResolvedValueOnce({ id: 'cus_new' });
    mockAccountUpdateStripe.mockResolvedValueOnce({
      id: accountId,
      stripeCustomerId: 'cus_new',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([]);

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(summary.stripeCustomerCreated).toBe(true);
    expect(summary.stripeCustomerId).toBe('cus_new');
    expect(mockStripeCreate).toHaveBeenCalledTimes(1);
    expect(mockAccountUpdateStripe).toHaveBeenCalledWith(accountId, 'cus_new');
  });

  it('compensating-delete: rolls back Stripe customer if updateStripeCustomerId fails', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: null,
      email: 'person@example.com',
      firstName: 'Chi',
      lastName: 'Chao',
    });
    mockStripeCreate.mockResolvedValueOnce({ id: 'cus_orphan' });
    mockAccountUpdateStripe.mockRejectedValueOnce(new Error('DB write failed'));
    mockStripeDelete.mockResolvedValueOnce({ deleted: true });

    await expect(service.reprovision(accountId, 'admin-1'))
      .rejects.toThrow('DB write failed');

    // Compensating Stripe.del must have been called to clean up the orphan
    expect(mockStripeDelete).toHaveBeenCalledWith('cus_orphan');
  });

  it('calls tenantService.activate for each owned tenant', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([
      { id: 'tenant-1' },
      { id: 'tenant-2' },
    ]);
    // F21 precheck: each tenant's status query precedes activate. Returning
    // status='pending' (or agent_execution_allowed=false) forces activate() to run.
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] });
    mockTenantActivate.mockResolvedValue({ id: 'tenant-X', status: 'active' });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(summary.stripeCustomerCreated).toBe(false);
    expect(summary.tenantsReactivated).toEqual(['tenant-1', 'tenant-2']);
    expect(mockTenantActivate).toHaveBeenCalledTimes(2);
  });

  it('skips activate() for suspended tenants (deliberate state)', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([{ id: 'tenant-suspended' }]);
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ status: 'suspended', agent_execution_allowed: false }],
    });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(mockTenantActivate).not.toHaveBeenCalled();
    expect(summary.tenantsReactivated).toEqual([]);
  });

  it('skips activate() for churned tenants (deliberate state)', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([{ id: 'tenant-churned' }]);
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ status: 'churned', agent_execution_allowed: false }],
    });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(mockTenantActivate).not.toHaveBeenCalled();
    expect(summary.tenantsReactivated).toEqual([]);
  });

  it('runs activate() for active tenant with agent_execution_allowed=false', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([{ id: 'tenant-active-disabled' }]);
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ status: 'active', agent_execution_allowed: false }],
    });
    mockTenantActivate.mockResolvedValueOnce({ id: 'tenant-active-disabled' });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(mockTenantActivate).toHaveBeenCalledWith('tenant-active-disabled');
    expect(summary.tenantsReactivated).toEqual(['tenant-active-disabled']);
  });

  it('skips activate() for tenants already active + provisioned (F21)', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([
      { id: 'tenant-already-done' },
      { id: 'tenant-stuck' },
    ]);
    mockAdminQuery
      // already-done tenant — precheck returns status='active', agent_execution_allowed=true.
      // reprovision must NOT call activate() for it.
      .mockResolvedValueOnce({ rows: [{ status: 'active', agent_execution_allowed: true }] })
      // stuck tenant — precheck returns pending, activate() runs.
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] });
    mockTenantActivate.mockResolvedValue({ id: 'tenant-stuck', status: 'active' });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(mockTenantActivate).toHaveBeenCalledTimes(1);
    expect(mockTenantActivate).toHaveBeenCalledWith('tenant-stuck');
    expect(summary.tenantsReactivated).toEqual(['tenant-stuck']);
  });

  it('continues past activate() failures and reports only successes', async () => {
    mockAccountFindById.mockResolvedValueOnce({
      id: accountId,
      firebaseUid: 'fb-uid',
      stripeCustomerId: 'cus_existing',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    mockTenantFindByAccountId.mockResolvedValueOnce([
      { id: 'tenant-1' },
      { id: 'tenant-2' },
      { id: 'tenant-3' },
    ]);
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending', agent_execution_allowed: false }] });
    mockTenantActivate
      .mockResolvedValueOnce({ id: 'tenant-1' })
      .mockRejectedValueOnce(new Error('subscription provision failed'))
      .mockResolvedValueOnce({ id: 'tenant-3' });

    const summary = await service.reprovision(accountId, 'admin-1');

    expect(summary.tenantsReactivated).toEqual(['tenant-1', 'tenant-3']);
  });

  it('throws AccountNotFoundError when account is missing', async () => {
    mockAccountFindById.mockResolvedValueOnce(null);
    await expect(service.reprovision(accountId, 'admin-1'))
      .rejects.toMatchObject({ name: 'AccountNotFoundError', accountId });
  });
});
