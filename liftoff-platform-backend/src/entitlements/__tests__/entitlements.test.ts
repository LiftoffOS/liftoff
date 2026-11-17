// Entitlement Service Tests
// Tests entitlement checks, feature flags, and quota management

import { EntitlementService } from '../service';
import { EntitlementRepository, CreateEntitlementInput } from '../repository';
import { Entitlement, UpdateEntitlementInput } from '../types';
import { createMockEntitlement } from '../../test-utils/mocks';

// Mock external dependencies
jest.mock('../../infrastructure/database');

// Mock the repository
jest.mock('../repository');

// Mock publishEvent - define inline since jest.mock is hoisted
jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

import { publishEvent } from '../../events/publisher';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

describe('EntitlementService', () => {
  let entitlementService: EntitlementService;
  let mockRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock repository
    mockRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    // Replace EntitlementRepository prototype methods
    (EntitlementRepository as jest.Mock).mockImplementation(() => mockRepository);

    entitlementService = new EntitlementService();
  });

  describe('getByTenantId', () => {
    it('should return entitlement when found', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_123',
        tenantId: 'tenant_123',
      });
      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_123');

      expect(mockRepository.findByTenantId).toHaveBeenCalledWith('tenant_123');
      expect(result).toEqual(entitlement);
    });

    it('should return null when entitlement not found', async () => {
      mockRepository.findByTenantId.mockResolvedValue(null);

      const result = await entitlementService.getByTenantId('tenant_nonexistent');

      expect(mockRepository.findByTenantId).toHaveBeenCalledWith('tenant_nonexistent');
      expect(result).toBeNull();
    });

    it('should propagate repository errors', async () => {
      mockRepository.findByTenantId.mockRejectedValue(new Error('Database error'));

      await expect(entitlementService.getByTenantId('tenant_123')).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('listAll', () => {
    it('should return all entitlements', async () => {
      const entitlements = [
        createMockEntitlement({ id: 'ent_1', tenantId: 'tenant_1' }),
        createMockEntitlement({ id: 'ent_2', tenantId: 'tenant_2' }),
        createMockEntitlement({ id: 'ent_3', tenantId: 'tenant_3' }),
      ];
      mockRepository.findAll.mockResolvedValue(entitlements);

      const result = await entitlementService.listAll();

      expect(mockRepository.findAll).toHaveBeenCalled();
      expect(result).toHaveLength(3);
      expect(result).toEqual(entitlements);
    });

    it('should return empty array when no entitlements exist', async () => {
      mockRepository.findAll.mockResolvedValue([]);

      const result = await entitlementService.listAll();

      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    const createInput: CreateEntitlementInput = {
      tenantId: 'tenant_new_123',
      tenantOperationalStatus: 'pending',
    };

    it('should create entitlement with provided values', async () => {
      const createdEntitlement = createMockEntitlement({
        id: 'ent_new_123',
        tenantId: createInput.tenantId,
        tenantOperationalStatus: 'pending',
      });

      mockRepository.create.mockResolvedValue(createdEntitlement);

      const result = await entitlementService.create(createInput);

      expect(mockRepository.create).toHaveBeenCalledWith(createInput);
      expect(result.tenantId).toBe('tenant_new_123');
    });

    it('should create entitlement with default values', async () => {
      const minimalInput: CreateEntitlementInput = {
        tenantId: 'tenant_minimal',
      };

      const createdEntitlement = createMockEntitlement({
        id: 'ent_minimal',
        tenantId: 'tenant_minimal',
        tenantOperationalStatus: 'pending',
      });

      mockRepository.create.mockResolvedValue(createdEntitlement);

      const result = await entitlementService.create(minimalInput);

      expect(mockRepository.create).toHaveBeenCalledWith(minimalInput);
      expect(result).toBeDefined();
    });

    it('should throw error when repository create fails', async () => {
      mockRepository.create.mockRejectedValue(new Error('Duplicate entry'));

      await expect(entitlementService.create(createInput)).rejects.toThrow(
        'Duplicate entry'
      );
    });
  });

  describe('update', () => {
    const tenantId = 'tenant_update_123';

    it('should update entitlement operational status', async () => {
      const updateInput: UpdateEntitlementInput = {
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_update_123',
        tenantId,
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update(tenantId, updateInput);

      expect(mockRepository.update).toHaveBeenCalledWith(tenantId, updateInput);
      expect(result.tenantOperationalStatus).toBe('active');
      expect(result.agentExecutionAllowed).toBe(true);
    });

    it('should publish tenant.entitlement.updated event after update', async () => {
      const updateInput: UpdateEntitlementInput = {
        tenantOperationalStatus: 'suspended',
        agentExecutionAllowed: false,
        remainingIncludedCredits: 0,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_event_123',
        tenantId,
        tenantOperationalStatus: 'suspended',
        agentExecutionAllowed: false,
        remainingIncludedCredits: 0,
        version: 3,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      await entitlementService.update(tenantId, updateInput);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'entitlement',
        entityId: updatedEntitlement.id,
        eventType: 'tenant.entitlement.updated',
        entityVersion: 3,
        eventVersion: 1,
        tenantId,
        payload: {
          tenantOperationalStatus: 'suspended',
          agentExecutionAllowed: false,
          // The control plane's billing hard stop travels with the execution
          // signal so the runtime's gate and execution-guard cannot diverge.
          billingSuspended: false,
          remainingIncludedCredits: 0,
          overageAllowed: updatedEntitlement.overageAllowed,
        },
      });
    });

    it('should update credits and overage settings', async () => {
      const updateInput: UpdateEntitlementInput = {
        remainingIncludedCredits: 500,
        overageAllowed: false,
        includedMonthlyCredits: 1000,
        overageCeiling: 500,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_credits_123',
        tenantId,
        remainingIncludedCredits: 500,
        overageAllowed: false,
        includedMonthlyCredits: 1000,
        overageCeiling: 500,
        version: 4,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update(tenantId, updateInput);

      expect(result.remainingIncludedCredits).toBe(500);
      expect(result.overageAllowed).toBe(false);
      expect(result.overageCeiling).toBe(500);
    });

    it('should throw error when entitlement not found', async () => {
      const updateInput: UpdateEntitlementInput = {
        tenantOperationalStatus: 'active',
      };

      mockRepository.update.mockRejectedValue(
        new Error('Entitlement not found for tenant: tenant_missing')
      );

      await expect(
        entitlementService.update('tenant_missing', updateInput)
      ).rejects.toThrow('Entitlement not found for tenant: tenant_missing');
    });

    it('should handle partial updates correctly', async () => {
      // Only updating one field should not affect others
      const updateInput: UpdateEntitlementInput = {
        overageCeiling: 2000,
      };

      const originalEntitlement = createMockEntitlement({
        id: 'ent_partial_123',
        tenantId,
        overageCeiling: 1000,
        includedMonthlyCredits: 1000,
        version: 1,
      });

      const updatedEntitlement = createMockEntitlement({
        ...originalEntitlement,
        overageCeiling: 2000,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update(tenantId, updateInput);

      expect(result.overageCeiling).toBe(2000);
      expect(result.includedMonthlyCredits).toBe(1000); // Unchanged
    });
  });

  // ── enableAgentExecution ──────────────────────────────────────────────────
  //
  // The single entry point for agent_execution_allowed = TRUE. Three call sites
  // used to issue that UPDATE as raw SQL: the version never moved and no event
  // fired, so a tenant could be cleared to run agents while every consumer of
  // the entitlement snapshot still believed it was not — including the tenant
  // runtime's cached copy, which (being version-guarded) had no way to learn
  // otherwise.

  describe('enableAgentExecution', () => {
    const tenantId = 'tenant_enable_123';

    it('flips the flag through update, so the version moves and the event fires', async () => {
      const before = createMockEntitlement({ tenantId, agentExecutionAllowed: false, version: 2 });
      const after = createMockEntitlement({ tenantId, agentExecutionAllowed: true, version: 3 });
      // findByTenantId is read three times: the already-enabled pre-check, the
      // pre-update audit snapshot, then the post-update re-read that supplies
      // the joined billingSuspended for the published payload.
      mockRepository.findByTenantId
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after);
      mockRepository.update.mockResolvedValue(after);
      mockRepository.createSnapshot = jest.fn().mockResolvedValue(undefined) as never;

      await entitlementService.enableAgentExecution(tenantId);

      expect(mockRepository.update).toHaveBeenCalledWith(tenantId, { agentExecutionAllowed: true });
      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tenant.entitlement.updated',
          payload: expect.objectContaining({ agentExecutionAllowed: true }),
        }),
      );
    });

    it('is a no-op when execution is already allowed', async () => {
      // Every caller sits behind a retried webhook or a retried outbox row.
      // Re-running update would write an entitlement_snapshots row and publish
      // an event for a flag that did not change.
      mockRepository.findByTenantId.mockResolvedValue(
        createMockEntitlement({ tenantId, agentExecutionAllowed: true }),
      );

      const result = await entitlementService.enableAgentExecution(tenantId);

      expect(result).toBeNull();
      expect(mockRepository.update).not.toHaveBeenCalled();
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    it('is a no-op when the tenant has no entitlement row', async () => {
      mockRepository.findByTenantId.mockResolvedValue(null);

      const result = await entitlementService.enableAgentExecution(tenantId);

      expect(result).toBeNull();
      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('Event payload structure', () => {
    it('should include all runtime-facing entitlement fields in event payload', async () => {
      const updateInput: UpdateEntitlementInput = {
        tenantOperationalStatus: 'active',
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_payload_test',
        tenantId: 'tenant_payload',
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
        remainingIncludedCredits: 1000,
        overageAllowed: true,
        version: 1,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      await entitlementService.update('tenant_payload', updateInput);

      const publishCall = mockPublishEvent.mock.calls[0][0];

      // Verify all required fields are present in the payload
      expect(publishCall.payload).toHaveProperty('tenantOperationalStatus');
      expect(publishCall.payload).toHaveProperty('agentExecutionAllowed');
      expect(publishCall.payload).toHaveProperty('remainingIncludedCredits');
      expect(publishCall.payload).toHaveProperty('overageAllowed');
    });
  });
});

describe('EntitlementRepository integration', () => {
  // These tests verify the mapping between service and repository

  it('should correctly pass all update fields to repository', async () => {
    const mockRepo = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue(createMockEntitlement()),
    };

    (EntitlementRepository as jest.Mock).mockImplementation(() => mockRepo);

    const service = new EntitlementService();
    const fullUpdate: UpdateEntitlementInput = {
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      remainingIncludedCredits: 500,
      overageAllowed: true,
      includedMonthlyCredits: 2000,
      overageCeiling: 500,
    };

    await service.update('tenant_full_update', fullUpdate);

    expect(mockRepo.update).toHaveBeenCalledWith('tenant_full_update', fullUpdate);
  });
});

describe('Entitlement quota checks', () => {
  // These tests document the expected behavior of entitlement credit checking

  describe('credit limits', () => {
    it('should have remainingIncludedCredits property', () => {
      const entitlement = createMockEntitlement({
        remainingIncludedCredits: 1000,
      });

      expect(entitlement.remainingIncludedCredits).toBe(1000);
    });

    it('should have overageAllowed property', () => {
      const entitlement = createMockEntitlement({
        overageAllowed: true,
      });

      expect(entitlement.overageAllowed).toBe(true);
    });

    it('should have overageCeiling property', () => {
      const entitlement = createMockEntitlement({
        overageCeiling: 500,
      });

      expect(entitlement.overageCeiling).toBe(500);
    });
  });

  describe('operational status', () => {
    it('should have tenantOperationalStatus property', () => {
      const entitlement = createMockEntitlement({
        tenantOperationalStatus: 'active',
      });

      expect(entitlement.tenantOperationalStatus).toBe('active');
    });

    it('should have agentExecutionAllowed property', () => {
      const entitlement = createMockEntitlement({
        agentExecutionAllowed: true,
      });

      expect(entitlement.agentExecutionAllowed).toBe(true);
    });

    it.each(['active', 'suspended', 'pending'] as const)(
      'should support %s operational status',
      (status) => {
        const entitlement = createMockEntitlement({
          tenantOperationalStatus: status,
        });

        expect(entitlement.tenantOperationalStatus).toBe(status);
      }
    );
  });
});

describe('Entitlement type validation', () => {
  it('should have all required fields', () => {
    const entitlement: Entitlement = {
      id: 'ent_123',
      tenantId: 'tenant_123',
      version: 1,
      // Team capacity
      teamCount: 5,
      isCustomPricing: false,
      // Runtime fields
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      remainingIncludedCredits: 1000,
      overageAllowed: true,
      includedMonthlyCredits: 1000,
      overageCeiling: 1000,
      // Paid add-on features
      advancedAnalyticsEnabled: false,
      sharedCollaborationEnabled: false,
      humanExpertsEnabled: false,
      prioritySupportEnabled: false,
      dedicatedSupportEnabled: false,
      advancedSecurityEnabled: false,
      complianceEnabled: false,
      ssoEnabled: false,
      overageProtectionEnabled: false,
      customRetentionEnabled: false,
      // Autonomous operation features
      scheduledAgentsEnabled: false,
      agentDelegationEnabled: false,
      crossAgentLearningEnabled: false,
      autoReflectionEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(entitlement.id).toBeDefined();
    expect(entitlement.tenantId).toBeDefined();
    expect(entitlement.version).toBeDefined();
    expect(entitlement.tenantOperationalStatus).toBeDefined();
    expect(entitlement.agentExecutionAllowed).toBeDefined();
    expect(entitlement.remainingIncludedCredits).toBeDefined();
    expect(entitlement.overageAllowed).toBeDefined();
    expect(entitlement.includedMonthlyCredits).toBeDefined();
    expect(entitlement.overageCeiling).toBeDefined();
    expect(entitlement.createdAt).toBeInstanceOf(Date);
    expect(entitlement.updatedAt).toBeInstanceOf(Date);
  });
});
