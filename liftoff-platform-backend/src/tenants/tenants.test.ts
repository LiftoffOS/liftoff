// Tenant Service Tests
// Tests tenant provisioning and lifecycle management

import { TenantService } from './service';
import { TenantRepository } from './repository';
import { ProvisionTenantInput } from './types';
import { EntitlementRepository } from '../entitlements/repository';
import { TenantMembersRepository } from '../tenant-members/repository';
import { createMockTenant, createMockEntitlement } from '../test-utils/mocks';
import { NoPaymentMethodError } from '../billing/billing-admin-client';

// Mock external dependencies
const mockPoolQuery = jest.fn();
const mockAdminQuery = jest.fn();

jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
  })),
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
  // withAdminScope drives the new provision/activate/suspend/reactivate code path.
  // The fake client routes queries through mockAdminQuery so BEGIN/COMMIT/ROLLBACK
  // and any direct INSERT/UPDATE inside the scope can be asserted.
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockAdminQuery }),
  ),
}));

// Outbox functions are called from TenantService.activate's failure path.
// Mock as no-ops so tests don't need to set up the outbox infrastructure.
// Inline jest.fn() inside the factory to avoid hoisting-vs-const issues.
jest.mock('../billing/provisioning-outbox-worker', () => ({
  // enqueueProvisioningOutbox returns { inserted: boolean } so callers can
  // observe ON CONFLICT DO NOTHING. Default to inserted=true; tests can
  // override per-call.
  enqueueProvisioningOutbox: jest.fn().mockResolvedValue({ inserted: true }),
  kickProvisioningOutbox: jest.fn(),
}));

// Enabling execution goes through the entitlement SERVICE, not a raw UPDATE:
// the raw form left `version` unchanged and published no event, so the tenant
// runtime's cached entitlement never learned the tenant had been cleared to run
// agents.
const mockEnableAgentExecution = jest.fn().mockResolvedValue(undefined);
jest.mock('../entitlements/service', () => ({
  EntitlementService: jest.fn().mockImplementation(() => ({
    enableAgentExecution: mockEnableAgentExecution,
  })),
}));

// Mock logging so the CRITICAL-log assertion in activate's catch-of-catch can be verified.
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// Mock billing admin client. Spread the real module so NoPaymentMethodError is
// the SAME class activate() imports — a hand-rolled stub would make the
// `instanceof` check false and the deferred branch would never be taken, so the
// test would pass while exercising nothing.
const mockProvisionSubscription = jest.fn();
jest.mock('../billing/billing-admin-client', () => ({
  ...jest.requireActual('../billing/billing-admin-client'),
  getBillingAdminClient: jest.fn(() => ({
    provisionSubscription: mockProvisionSubscription,
  })),
}));

// Mock repositories
jest.mock('./repository');
jest.mock('../entitlements/repository');
jest.mock('../tenant-members/repository');

// Side-channel for the mock: each mutateAndPublishEvent invocation appends its
// resolved eventInput here so tests can assert what would have been published.
// Reset in beforeEach.
const capturedEventInputs: unknown[] = [];

// Mock publishEvent + mutateAndPublishEvent — both are exported from publisher.
// The shape-3 mutateAndPublishEvent runs the caller's
// mutate callback under withAdminScope and inline-publishes after commit.
// For unit tests we execute the callback against the mocked withAdminScope
// client, capture the eventInput, and return the callback's `entity` field —
// mirroring the production function's return contract (helper returns entity,
// not the wrapper).
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  mutateAndPublishEvent: jest.fn(async <T>(
    _ctx: unknown,
    mutate: (client: { query: jest.Mock }) => Promise<{ entity: T; eventInput: unknown }>,
  ): Promise<T> => {
    const db = jest.requireMock('../infrastructure/database') as { withAdminScope?: (ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => Promise<unknown> };
    if (db.withAdminScope) {
      const result = await db.withAdminScope({ caller: 'test' }, async (client) => {
        const { entity, eventInput } = await mutate(client);
        capturedEventInputs.push(eventInput);
        return { entity };
      }) as { entity: T };
      return result.entity;
    }
    const stubClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const { entity, eventInput } = await mutate(stubClient);
    capturedEventInputs.push(eventInput);
    return entity;
  }),
}));

// Mock infrastructure provisioning service to avoid GCP API calls
jest.mock('../infrastructure/provisioning', () => ({
  infrastructureProvisioningService: {
    provisionTenantInfrastructure: jest.fn().mockResolvedValue({
      success: true,
      buildId: 'mock-build-123',
      gcpProjectId: 'mock-project-id',
    }),
    checkProvisioningStatus: jest.fn().mockResolvedValue({ status: 'success' }),
    deprovisionTenantInfrastructure: jest.fn().mockResolvedValue({ success: true }),
  },
}));

// `capturedEventInputs` (above) holds every eventInput passed to
// mutateAndPublishEvent in this test run — assertions below check it.

describe('TenantService', () => {
  let tenantService: TenantService;
  let mockTenantRepository: jest.Mocked<TenantRepository>;
  let mockEntitlementRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedEventInputs.length = 0;

    // The SHARED_TENANCY_ENABLED gate was removed in PR 2 — shared hosting is
    // the default. This env var is preserved for any other callers but no
    // longer affects provision().
    process.env.SHARED_TENANCY_ENABLED = 'true';

    // Default: no stripe customer on account (billing path skipped)
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockAdminQuery.mockResolvedValue({ rowCount: 0, rows: [] });

    // jest.clearAllMocks resets call records but jest's mockReset behavior on
    // the auto-mocked module fns means the default we set at jest.mock time
    // can be lost; re-establish the resolved value here. enqueue returns
    // { inserted: boolean } so destructuring at the call site works.
    const outboxMock = jest.requireMock('../billing/provisioning-outbox-worker');
    (outboxMock.enqueueProvisioningOutbox as jest.Mock).mockResolvedValue({ inserted: true });
    // Default: subscription does not already exist
    mockProvisionSubscription.mockResolvedValue({ alreadyExists: false });

    // Create mock tenant repository — now includes createInTx
    mockTenantRepository = {
      create: jest.fn(),
      createInTx: jest.fn(),
      findById: jest.fn(),
      findByAccountId: jest.fn(),
      findAll: jest.fn(),
      updateStatus: jest.fn(),
      updateMigrationStatus: jest.fn(),
      updateGcpProject: jest.fn(),
      updateRuntimeUrl: jest.fn(),
      markHasCreatedInternalAgent: jest.fn(),
      updateName: jest.fn(),
      getMigrationStatus: jest.fn(),
      getMigrationHistory: jest.fn(),
    } as unknown as jest.Mocked<TenantRepository>;

    // Create mock entitlement repository — now includes updateInTx + createInTx
    mockEntitlementRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      createInTx: jest.fn(),
      update: jest.fn(),
      updateInTx: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    // Replace repository prototype methods
    (TenantRepository as jest.Mock).mockImplementation(() => mockTenantRepository);
    (EntitlementRepository as jest.Mock).mockImplementation(() => mockEntitlementRepository);
    (TenantMembersRepository as jest.Mock).mockImplementation(() => ({
      createMember: jest.fn().mockResolvedValue({ id: 'member-mock-123', role: 'owner' }),
      createMemberInTx: jest.fn().mockResolvedValue({ id: 'member-mock-123', role: 'owner' }),
    }));

    tenantService = new TenantService();
  });

  describe('provision', () => {
    const provisionInput: ProvisionTenantInput = {
      accountId: 'acc_123',
      name: 'Production Tenant',
    };

    it('should create tenant + member + entitlement atomically and activate', async () => {
      const createdTenant = createMockTenant({
        id: 'tenant_new_123',
        accountId: provisionInput.accountId,
        name: provisionInput.name,
        status: 'pending',
        migrationStatus: 'pending',
      });

      const activatedTenant = createMockTenant({
        ...createdTenant,
        status: 'active',
      });

      const createdEntitlement = createMockEntitlement({
        id: 'ent_new_123',
        tenantId: createdTenant.id,
        tenantOperationalStatus: 'pending',
      });

      // Repositories are called via the *InTx variants from inside withAdminScope.
      mockTenantRepository.createInTx.mockResolvedValue(createdTenant);
      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.createInTx.mockResolvedValue(createdEntitlement);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createdEntitlement);

      const result = await tenantService.provision(provisionInput);

      expect(mockTenantRepository.createInTx).toHaveBeenCalled();
      const createInTxCallArgs = mockTenantRepository.createInTx.mock.calls[0][1];
      expect(createInTxCallArgs).toEqual(provisionInput);

      expect(mockEntitlementRepository.createInTx).toHaveBeenCalled();
      const eCreateArgs = mockEntitlementRepository.createInTx.mock.calls[0][1];
      expect(eCreateArgs).toEqual({
        tenantId: createdTenant.id,
        tenantOperationalStatus: 'pending',
      });

      // withAdminScope owns the transaction — the service callback must NOT
      // issue its own BEGIN/COMMIT/ROLLBACK. Nesting would prematurely close
      // the wrapper's outer tx and break the wrapper's ROLLBACK-on-error
      // guarantee.
      const txControlCalls = mockAdminQuery.mock.calls.filter((c) =>
        c[0] === 'BEGIN' || c[0] === 'COMMIT' || c[0] === 'ROLLBACK',
      );
      expect(txControlCalls).toEqual([]);

      expect(result.id).toBe('tenant_new_123');
      // Activated immediately after provision
      expect(result.status).toBe('active');
    });

    it('should publish tenant.provisioned event', async () => {
      const createdTenant = createMockTenant({
        id: 'tenant_event_123',
        accountId: 'acc_event',
        name: 'Event Tenant',
      });

      const activatedTenant = createMockTenant({
        ...createdTenant,
        status: 'active',
      });

      const createdEntitlement = createMockEntitlement({
        id: 'ent_event_123',
        tenantId: createdTenant.id,
      });

      mockTenantRepository.createInTx.mockResolvedValue(createdTenant);
      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.createInTx.mockResolvedValue(createdEntitlement);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createdEntitlement);

      await tenantService.provision(provisionInput);

      // tenant.provisioned now fires via mutateAndPublishEvent (shape-3).
      expect(capturedEventInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityType: 'tenant',
            entityId: createdTenant.id,
            eventType: 'tenant.provisioned',
            tenantId: createdTenant.id,
          }),
        ]),
      );
    });

    it('rolls back transaction if tenant insert fails (no member/entitlement created)', async () => {
      mockTenantRepository.createInTx.mockRejectedValue(
        new Error('Database constraint violation')
      );

      await expect(tenantService.provision(provisionInput)).rejects.toThrow(
        'Database constraint violation'
      );

      // The wrapper (withAdminScope) ROLLs back on thrown errors — the
      // service callback does NOT issue its own transaction control.
      // entitlement.createInTx is never called because the tenant insert
      // threw before reaching it.
      const txControlCalls = mockAdminQuery.mock.calls.filter((c) =>
        c[0] === 'BEGIN' || c[0] === 'COMMIT' || c[0] === 'ROLLBACK',
      );
      expect(txControlCalls).toEqual([]);
      expect(mockEntitlementRepository.createInTx).not.toHaveBeenCalled();
    });

    it('rolls back transaction if entitlement insert fails (tenant + member rolled back too)', async () => {
      const createdTenant = createMockTenant({ id: 'tenant_123' });
      mockTenantRepository.createInTx.mockResolvedValue(createdTenant);
      mockEntitlementRepository.createInTx.mockRejectedValue(
        new Error('Entitlement creation failed')
      );

      await expect(tenantService.provision(provisionInput)).rejects.toThrow(
        'Entitlement creation failed'
      );

      // Same: no inner BEGIN/COMMIT/ROLLBACK in the callback. The wrapper
      // owns the tx and rolls back when the callback throws.
      const txControlCalls = mockAdminQuery.mock.calls.filter((c) =>
        c[0] === 'BEGIN' || c[0] === 'COMMIT' || c[0] === 'ROLLBACK',
      );
      expect(txControlCalls).toEqual([]);
    });

    it('hosting_mode defaults to shared for new signups regardless of tier', async () => {
      const createdTenant = createMockTenant({
        id: 'tenant_hosting_mode',
        hostingMode: 'shared',
      });
      mockTenantRepository.createInTx.mockResolvedValue(createdTenant);
      mockTenantRepository.updateStatus.mockResolvedValue(createdTenant);
      mockEntitlementRepository.createInTx.mockResolvedValue(
        createMockEntitlement({ tenantId: createdTenant.id }),
      );
      mockEntitlementRepository.updateInTx.mockResolvedValue(
        createMockEntitlement({ tenantId: createdTenant.id }),
      );

      const result = await tenantService.provision({
        ...provisionInput,
        tier: 'enterprise',  // tier=enterprise no longer drives hosting_mode
      });

      expect(result.hostingMode).toBe('shared');
    });
  });

  describe('getById', () => {
    it('should return tenant when found', async () => {
      const tenant = createMockTenant({ id: 'tenant_find_123' });
      mockTenantRepository.findById.mockResolvedValue(tenant);

      const result = await tenantService.getById('tenant_find_123');

      expect(mockTenantRepository.findById).toHaveBeenCalledWith('tenant_find_123');
      expect(result).toEqual(tenant);
    });

    it('should return null when tenant not found', async () => {
      mockTenantRepository.findById.mockResolvedValue(null);

      const result = await tenantService.getById('tenant_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getByAccountId', () => {
    it('should return all tenants for an account', async () => {
      const tenants = [
        createMockTenant({ id: 'tenant_1', accountId: 'acc_123', name: 'Dev' }),
        createMockTenant({ id: 'tenant_2', accountId: 'acc_123', name: 'Prod' }),
      ];
      mockTenantRepository.findByAccountId.mockResolvedValue(tenants);

      const result = await tenantService.getByAccountId('acc_123');

      expect(mockTenantRepository.findByAccountId).toHaveBeenCalledWith('acc_123');
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no tenants exist', async () => {
      mockTenantRepository.findByAccountId.mockResolvedValue([]);

      const result = await tenantService.getByAccountId('acc_no_tenants');

      expect(result).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should return all tenants', async () => {
      const tenants = [
        createMockTenant({ id: 'tenant_1' }),
        createMockTenant({ id: 'tenant_2' }),
        createMockTenant({ id: 'tenant_3' }),
      ];
      mockTenantRepository.findAll.mockResolvedValue(tenants);

      const result = await tenantService.listAll();

      expect(mockTenantRepository.findAll).toHaveBeenCalled();
      expect(result).toHaveLength(3);
    });
  });

  describe('activate', () => {
    it('should update tenant and entitlement status to active with agentExecutionAllowed=false', async () => {
      const activatedTenant = createMockTenant({
        id: 'tenant_activate_123',
        status: 'active',
      });

      const activatedEntitlement = createMockEntitlement({
        tenantId: 'tenant_activate_123',
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: false,
      });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(activatedEntitlement);

      const result = await tenantService.activate('tenant_activate_123');

      expect(mockTenantRepository.updateStatus).toHaveBeenCalledWith(
        'tenant_activate_123',
        'active'
      );
      expect(mockEntitlementRepository.updateInTx).toHaveBeenCalledWith(
        expect.any(Object),  // PoolClient (mocked as { query: mockAdminQuery })
        'tenant_activate_123',
        {
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: false,
        }
      );
      expect(result.status).toBe('active');
    });

    it('synchronously calls provisionSubscription with alreadyExists=true → enables execution through the entitlement service', async () => {
      const tenantId = 'tenant_already_subbed';
      const activatedTenant = createMockTenant({ id: tenantId, accountId: 'acc_existing', status: 'active' });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());
      mockPoolQuery.mockResolvedValue({ rows: [{ stripe_customer_id: 'cus_existing' }] });
      mockProvisionSubscription.mockResolvedValue({ alreadyExists: true });

      await tenantService.activate(tenantId);

      expect(mockProvisionSubscription).toHaveBeenCalledWith(tenantId, 'cus_existing');
      expect(mockEnableAgentExecution).toHaveBeenCalledWith(tenantId);
      // And NOT as a raw UPDATE — that path bumped no version and published
      // nothing, so no consumer of the entitlement snapshot could observe it.
      const rawUpdate = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE entitlements SET agent_execution_allowed = TRUE'),
      );
      expect(rawUpdate).toBeUndefined();
    });

    it('synchronously calls provisionSubscription with alreadyExists=false → does NOT flip agent_execution_allowed (webhook will)', async () => {
      const tenantId = 'tenant_new_sub';
      const activatedTenant = createMockTenant({ id: tenantId, accountId: 'acc_new', status: 'active' });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());
      mockPoolQuery.mockResolvedValue({ rows: [{ stripe_customer_id: 'cus_new' }] });
      mockProvisionSubscription.mockResolvedValue({ alreadyExists: false });

      await tenantService.activate(tenantId);

      expect(mockProvisionSubscription).toHaveBeenCalledWith(tenantId, 'cus_new');
      // No UPDATE entitlements SET agent_execution_allowed = TRUE on either pool
      const directUpdateOnPool = mockPoolQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE entitlements SET agent_execution_allowed = TRUE'),
      );
      const directUpdateOnAdmin = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE entitlements SET agent_execution_allowed = TRUE'),
      );
      expect(directUpdateOnPool).toBeUndefined();
      expect(directUpdateOnAdmin).toBeUndefined();
      // Nor through the service — the webhook owns this case.
      expect(mockEnableAgentExecution).not.toHaveBeenCalled();
    });

    it('enqueues outbox + kicks worker when provisionSubscription throws inline', async () => {
      const tenantId = 'tenant_outbox';
      const activatedTenant = createMockTenant({ id: tenantId, accountId: 'acc_outbox', status: 'active' });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());
      mockPoolQuery.mockResolvedValue({ rows: [{ stripe_customer_id: 'cus_outbox' }] });
      mockProvisionSubscription.mockRejectedValueOnce(new Error('Stripe down'));

      const { enqueueProvisioningOutbox, kickProvisioningOutbox } = jest.requireMock(
        '../billing/provisioning-outbox-worker',
      );

      // Should NOT throw — activate() returns successfully even on Stripe failure.
      await tenantService.activate(tenantId);

      expect(enqueueProvisioningOutbox).toHaveBeenCalledWith(tenantId, 'acc_outbox');
      expect(kickProvisioningOutbox).toHaveBeenCalled();
    });

    // Every self-serve signup lands here: the wizard collects payment at step 7
    // and activate() runs at step 0, so Stripe can only reject. Enqueueing would
    // spend the outbox's whole 10-attempt budget over ~2 days on something no
    // retry can fix.
    it('does NOT enqueue when the customer has no payment method yet', async () => {
      const tenantId = 'tenant_no_pm';
      const activatedTenant = createMockTenant({ id: tenantId, accountId: 'acc_no_pm', status: 'active' });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());
      mockPoolQuery.mockResolvedValue({ rows: [{ stripe_customer_id: 'cus_no_pm' }] });
      mockProvisionSubscription.mockRejectedValueOnce(
        new NoPaymentMethodError(tenantId, 'no attached payment source or default payment method'),
      );

      const { enqueueProvisioningOutbox, kickProvisioningOutbox } = jest.requireMock(
        '../billing/provisioning-outbox-worker',
      );

      await expect(tenantService.activate(tenantId)).resolves.toBeDefined();

      expect(enqueueProvisioningOutbox).not.toHaveBeenCalled();
      expect(kickProvisioningOutbox).not.toHaveBeenCalled();

      // Deferral is a normal signup state, so it must not surface as a warning.
      const { log } = jest.requireMock('../infrastructure/logging');
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('provisionSubscription failed inline'),
      );
    });

    it('logs CRITICAL and does NOT throw when enqueueProvisioningOutbox itself also throws', async () => {
      const tenantId = 'tenant_outbox_outage';
      const activatedTenant = createMockTenant({ id: tenantId, accountId: 'acc_outbox_outage', status: 'active' });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());
      mockPoolQuery.mockResolvedValue({ rows: [{ stripe_customer_id: 'cus_outage' }] });
      mockProvisionSubscription.mockRejectedValueOnce(new Error('Stripe down'));

      const { enqueueProvisioningOutbox, kickProvisioningOutbox } = jest.requireMock(
        '../billing/provisioning-outbox-worker',
      );
      // Outbox enqueue also fails (DB outage simultaneous with Stripe outage).
      (enqueueProvisioningOutbox as jest.Mock).mockRejectedValueOnce(new Error('DB outage'));

      const { log } = jest.requireMock('../infrastructure/logging');
      const mockLogError = log.error as jest.Mock;

      // activate() must NOT throw even when BOTH the primary call and the
      // outbox fallback fail — the tenant is already status='active' and
      // throwing here would break the signup HTTP response.
      await expect(tenantService.activate(tenantId)).resolves.toBeDefined();

      // CRITICAL log fired with both error messages + remediation hint.
      expect(mockLogError).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          accountId: 'acc_outbox_outage',
          primaryError: 'Stripe down',
          enqueueError: 'DB outage',
        }),
        expect.stringContaining('CRITICAL'),
      );
      // kick should NOT be called when enqueue failed (nothing to retry).
      expect(kickProvisioningOutbox).not.toHaveBeenCalled();
    });

    it('should publish tenant.activated event', async () => {
      const activatedTenant = createMockTenant({
        id: 'tenant_active_event',
        status: 'active',
      });

      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());

      await tenantService.activate('tenant_active_event');

      // tenant.activated now fires via mutateAndPublishEvent (shape-3).
      expect(capturedEventInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityType: 'tenant',
            entityId: 'tenant_active_event',
            eventType: 'tenant.activated',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: 'tenant_active_event',
            payload: {},
          }),
        ]),
      );
    });

    it('should throw error when tenant not found', async () => {
      mockTenantRepository.updateStatus.mockRejectedValue(
        new Error('Tenant not found: tenant_missing')
      );

      await expect(tenantService.activate('tenant_missing')).rejects.toThrow(
        'Tenant not found: tenant_missing'
      );
    });
  });

  describe('suspend', () => {
    it('should update tenant and entitlement status to suspended', async () => {
      const suspendedTenant = createMockTenant({
        id: 'tenant_suspend_123',
        status: 'suspended',
      });

      const suspendedEntitlement = createMockEntitlement({
        tenantId: 'tenant_suspend_123',
        tenantOperationalStatus: 'suspended',
        agentExecutionAllowed: false,
      });

      mockTenantRepository.updateStatus.mockResolvedValue(suspendedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(suspendedEntitlement);

      const result = await tenantService.suspend('tenant_suspend_123');

      expect(mockTenantRepository.updateStatus).toHaveBeenCalledWith(
        'tenant_suspend_123',
        'suspended'
      );
      expect(mockEntitlementRepository.updateInTx).toHaveBeenCalledWith(
        expect.any(Object),
        'tenant_suspend_123',
        {
          tenantOperationalStatus: 'suspended',
          agentExecutionAllowed: false,
        }
      );
      expect(result.status).toBe('suspended');
    });

    it('should publish tenant.suspended event', async () => {
      const suspendedTenant = createMockTenant({
        id: 'tenant_suspend_event',
        status: 'suspended',
      });

      mockTenantRepository.updateStatus.mockResolvedValue(suspendedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());

      await tenantService.suspend('tenant_suspend_event');

      // tenant.suspended now fires via mutateAndPublishEvent (shape-3).
      expect(capturedEventInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityType: 'tenant',
            entityId: 'tenant_suspend_event',
            eventType: 'tenant.suspended',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: 'tenant_suspend_event',
            payload: {},
          }),
        ]),
      );
    });

    it('should disable agent execution when suspending', async () => {
      const suspendedTenant = createMockTenant({
        id: 'tenant_no_agents',
        status: 'suspended',
      });

      mockTenantRepository.updateStatus.mockResolvedValue(suspendedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(
        createMockEntitlement({ agentExecutionAllowed: false })
      );

      await tenantService.suspend('tenant_no_agents');

      expect(mockEntitlementRepository.updateInTx).toHaveBeenCalledWith(
        expect.any(Object),
        'tenant_no_agents',
        expect.objectContaining({
          agentExecutionAllowed: false,
        })
      );
    });
  });

  describe('reactivate', () => {
    it('should reactivate a suspended tenant', async () => {
      const reactivatedTenant = createMockTenant({
        id: 'tenant_reactivate_123',
        status: 'active',
      });

      const reactivatedEntitlement = createMockEntitlement({
        tenantId: 'tenant_reactivate_123',
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
      });

      mockTenantRepository.updateStatus.mockResolvedValue(reactivatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(reactivatedEntitlement);

      const result = await tenantService.reactivate('tenant_reactivate_123');

      expect(mockTenantRepository.updateStatus).toHaveBeenCalledWith(
        'tenant_reactivate_123',
        'active'
      );
      expect(mockEntitlementRepository.updateInTx).toHaveBeenCalledWith(
        expect.any(Object),
        'tenant_reactivate_123',
        {
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
        }
      );
      expect(result.status).toBe('active');
    });

    it('should publish tenant.reactivated event', async () => {
      const reactivatedTenant = createMockTenant({
        id: 'tenant_reactivate_event',
        status: 'active',
      });

      mockTenantRepository.updateStatus.mockResolvedValue(reactivatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());

      await tenantService.reactivate('tenant_reactivate_event');

      // tenant.reactivated now fires via mutateAndPublishEvent (shape-3).
      expect(capturedEventInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityType: 'tenant',
            entityId: 'tenant_reactivate_event',
            eventType: 'tenant.reactivated',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: 'tenant_reactivate_event',
            payload: {},
          }),
        ]),
      );
    });
  });

  describe('updateMigrationStatus', () => {
    it('should update migration status to in_progress', async () => {
      const tenant = createMockTenant({
        id: 'tenant_migration_123',
        migrationStatus: 'in_progress',
      });

      mockTenantRepository.updateMigrationStatus.mockResolvedValue(tenant);

      const result = await tenantService.updateMigrationStatus(
        'tenant_migration_123',
        'in_progress'
      );

      expect(mockTenantRepository.updateMigrationStatus).toHaveBeenCalledWith(
        'tenant_migration_123',
        'in_progress'
      );
      expect(result.migrationStatus).toBe('in_progress');
    });

    it('should activate tenant when migration completes', async () => {
      const migratedTenant = createMockTenant({
        id: 'tenant_migrated_123',
        migrationStatus: 'completed',
        status: 'pending',
      });

      const activatedTenant = createMockTenant({
        ...migratedTenant,
        status: 'active',
      });

      mockTenantRepository.updateMigrationStatus.mockResolvedValue(migratedTenant);
      mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
      mockEntitlementRepository.updateInTx.mockResolvedValue(createMockEntitlement());

      const result = await tenantService.updateMigrationStatus(
        'tenant_migrated_123',
        'completed'
      );

      expect(mockTenantRepository.updateStatus).toHaveBeenCalledWith(
        'tenant_migrated_123',
        'active'
      );
      expect(result.status).toBe('active');
    });

    it('should not activate tenant when migration fails', async () => {
      const failedTenant = createMockTenant({
        id: 'tenant_failed_123',
        migrationStatus: 'failed',
        status: 'pending',
      });

      mockTenantRepository.updateMigrationStatus.mockResolvedValue(failedTenant);

      const result = await tenantService.updateMigrationStatus(
        'tenant_failed_123',
        'failed'
      );

      expect(mockTenantRepository.updateStatus).not.toHaveBeenCalled();
      expect(result.migrationStatus).toBe('failed');
    });

    it('should handle pending migration status', async () => {
      const tenant = createMockTenant({
        id: 'tenant_pending_123',
        migrationStatus: 'pending',
      });

      mockTenantRepository.updateMigrationStatus.mockResolvedValue(tenant);

      const result = await tenantService.updateMigrationStatus(
        'tenant_pending_123',
        'pending'
      );

      expect(mockTenantRepository.updateStatus).not.toHaveBeenCalled();
      expect(result.migrationStatus).toBe('pending');
    });
  });

  describe('updateGcpProject', () => {
    it('should update GCP project ID and database name', async () => {
      const updatedTenant = createMockTenant({
        id: 'tenant_gcp_123',
        gcpProjectId: 'tenant-123-runtime',
        databaseName: 'liftoff_tenant_123',
      });

      mockTenantRepository.updateGcpProject.mockResolvedValue(updatedTenant);

      const result = await tenantService.updateGcpProject(
        'tenant_gcp_123',
        'tenant-123-runtime',
        'liftoff_tenant_123'
      );

      expect(mockTenantRepository.updateGcpProject).toHaveBeenCalledWith(
        'tenant_gcp_123',
        'tenant-123-runtime',
        'liftoff_tenant_123'
      );
      expect(result.gcpProjectId).toBe('tenant-123-runtime');
      expect(result.databaseName).toBe('liftoff_tenant_123');
    });

    it('should throw error when tenant not found', async () => {
      mockTenantRepository.updateGcpProject.mockRejectedValue(
        new Error('Tenant not found: tenant_missing')
      );

      await expect(
        tenantService.updateGcpProject('tenant_missing', 'project-id', 'db-name')
      ).rejects.toThrow('Tenant not found: tenant_missing');
    });
  });
});

describe('TenantService lifecycle integration', () => {
  // Integration-style tests that verify the full lifecycle

  let tenantService: TenantService;
  let mockTenantRepository: jest.Mocked<TenantRepository>;
  let mockEntitlementRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default admin client query — succeeds with empty rowset.
    mockAdminQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockProvisionSubscription.mockResolvedValue({ alreadyExists: false });

    mockTenantRepository = {
      create: jest.fn(),
      createInTx: jest.fn(),
      findById: jest.fn(),
      findByAccountId: jest.fn(),
      findAll: jest.fn(),
      updateStatus: jest.fn(),
      updateMigrationStatus: jest.fn(),
      updateGcpProject: jest.fn(),
    } as unknown as jest.Mocked<TenantRepository>;

    mockEntitlementRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      createInTx: jest.fn(),
      update: jest.fn(),
      updateInTx: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    (TenantRepository as jest.Mock).mockImplementation(() => mockTenantRepository);
    (EntitlementRepository as jest.Mock).mockImplementation(() => mockEntitlementRepository);
    (TenantMembersRepository as jest.Mock).mockImplementation(() => ({
      createMember: jest.fn().mockResolvedValue({ id: 'member-mock-123', role: 'owner' }),
      createMemberInTx: jest.fn().mockResolvedValue({ id: 'member-mock-123', role: 'owner' }),
    }));

    tenantService = new TenantService();
  });

  it('should handle full provisioning to activation lifecycle', async () => {
    // Step 1: Provision (hostingMode always defaults to 'shared' in PR 2 —
    // dedicated is a manual admin upgrade, not part of provision()).
    const provisionedTenant = createMockTenant({
      id: 'tenant_lifecycle_123',
      tier: 'standard',
      hostingMode: 'shared',
      status: 'pending',
      migrationStatus: 'pending',
    });

    const activatedTenant = createMockTenant({
      ...provisionedTenant,
      status: 'active',
    });

    const provisionedEntitlement = createMockEntitlement({
      id: 'ent_lifecycle_123',
      tenantId: provisionedTenant.id,
      tenantOperationalStatus: 'pending',
    });

    mockTenantRepository.createInTx.mockResolvedValue(provisionedTenant);
    mockTenantRepository.updateStatus.mockResolvedValue(activatedTenant);
    mockEntitlementRepository.createInTx.mockResolvedValue(provisionedEntitlement);
    mockEntitlementRepository.updateInTx.mockResolvedValue(provisionedEntitlement);

    const provisioned = await tenantService.provision({
      accountId: 'acc_lifecycle',
      name: 'Lifecycle Test',
    });

    // PR 2: tenant is activated as part of provision() — status is 'active' on return.
    expect(provisioned.status).toBe('active');
    expect(provisioned.hostingMode).toBe('shared');

    // Step 2: Update GCP project after Terraform runs
    const withGcp = createMockTenant({
      ...provisionedTenant,
      gcpProjectId: 'tenant-lifecycle-123-runtime',
      databaseName: 'liftoff_lifecycle',
    });

    mockTenantRepository.updateGcpProject.mockResolvedValue(withGcp);

    const gcpUpdated = await tenantService.updateGcpProject(
      provisionedTenant.id,
      'tenant-lifecycle-123-runtime',
      'liftoff_lifecycle'
    );

    expect(gcpUpdated.gcpProjectId).toBe('tenant-lifecycle-123-runtime');

    // Step 3: Complete migration
    const migratedTenant = createMockTenant({
      ...withGcp,
      migrationStatus: 'completed',
    });

    const finalActivatedTenant = createMockTenant({
      ...migratedTenant,
      status: 'active',
    });

    mockTenantRepository.updateMigrationStatus.mockResolvedValue(migratedTenant);
    mockTenantRepository.updateStatus.mockResolvedValue(finalActivatedTenant);
    mockEntitlementRepository.updateInTx.mockResolvedValue(
      createMockEntitlement({
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
      })
    );

    const activated = await tenantService.updateMigrationStatus(
      provisionedTenant.id,
      'completed'
    );

    expect(activated.status).toBe('active');
  });
});
