// Entitlement Service Tests
// Tests entitlement snapshot management

import { EntitlementService } from './service';
import { EntitlementRepository, CreateEntitlementInput } from './repository';
import { UpdateEntitlementInput } from './types';
import { createMockEntitlement } from '../test-utils/mocks';

// Mock external dependencies
jest.mock('../infrastructure/database');

// Mock the repository
jest.mock('./repository');

// Mock publishEvent - define inline since jest.mock is hoisted
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

import { publishEvent } from '../events/publisher';
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

// Tests for team count based capacity model
describe('Team Count Based Capacity', () => {
  let entitlementService: EntitlementService;
  let mockRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    (EntitlementRepository as jest.Mock).mockImplementation(() => mockRepository);
    entitlementService = new EntitlementService();
  });

  describe('Standard team capacity', () => {
    it('should support 10 team capacity', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_10_teams',
        tenantId: 'tenant_10',
        teamCount: 10,
        isCustomPricing: false,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_10');

      expect(result?.teamCount).toBe(10);
      expect(result?.isCustomPricing).toBe(false);
    });

    it('should support 50 team capacity', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_50_teams',
        tenantId: 'tenant_50',
        teamCount: 50,
        isCustomPricing: false,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_50');

      expect(result?.teamCount).toBe(50);
    });

    it('should support 200 team capacity', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_200_teams',
        tenantId: 'tenant_200',
        teamCount: 200,
        isCustomPricing: false,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_200');

      expect(result?.teamCount).toBe(200);
    });
  });

  describe('Custom pricing (enterprise)', () => {
    it('should support custom pricing flag', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_enterprise',
        tenantId: 'tenant_enterprise',
        teamCount: 500,
        isCustomPricing: true,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_enterprise');

      expect(result?.isCustomPricing).toBe(true);
      expect(result?.teamCount).toBe(500);
    });
  });

  describe('Team count updates', () => {
    it('should update team count', async () => {
      const updateInput: UpdateEntitlementInput = {
        teamCount: 25,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_upgrade',
        tenantId: 'tenant_upgrade',
        teamCount: 25,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_upgrade', updateInput);

      expect(mockRepository.update).toHaveBeenCalledWith('tenant_upgrade', updateInput);
      expect(result.teamCount).toBe(25);
    });
  });
});

// Tests for paid add-on features
describe('Paid Add-on Features', () => {
  let entitlementService: EntitlementService;
  let mockRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    (EntitlementRepository as jest.Mock).mockImplementation(() => mockRepository);
    entitlementService = new EntitlementService();
  });

  describe('Add-on feature defaults', () => {
    it('should have all add-ons disabled by default', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_default',
        tenantId: 'tenant_default',
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_default');

      // All paid add-ons should be disabled by default
      expect(result?.advancedAnalyticsEnabled).toBe(false);
      expect(result?.sharedCollaborationEnabled).toBe(false);
      expect(result?.humanExpertsEnabled).toBe(false);
      expect(result?.prioritySupportEnabled).toBe(false);
      expect(result?.dedicatedSupportEnabled).toBe(false);
      expect(result?.advancedSecurityEnabled).toBe(false);
      expect(result?.complianceEnabled).toBe(false);
      expect(result?.ssoEnabled).toBe(false);
      expect(result?.overageProtectionEnabled).toBe(false);
      expect(result?.customRetentionEnabled).toBe(false);
      expect(result?.scheduledAgentsEnabled).toBe(false);
      expect(result?.agentDelegationEnabled).toBe(false);
      expect(result?.crossAgentLearningEnabled).toBe(false);
      expect(result?.autoReflectionEnabled).toBe(false);
    });
  });

  describe('Add-on feature activation', () => {
    it('should enable advanced analytics add-on', async () => {
      const updateInput: UpdateEntitlementInput = {
        advancedAnalyticsEnabled: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_analytics',
        tenantId: 'tenant_analytics',
        advancedAnalyticsEnabled: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_analytics', updateInput);

      expect(result.advancedAnalyticsEnabled).toBe(true);
    });

    it('should enable compliance add-on (SOC2 & GDPR)', async () => {
      const updateInput: UpdateEntitlementInput = {
        complianceEnabled: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_compliance',
        tenantId: 'tenant_compliance',
        complianceEnabled: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_compliance', updateInput);

      expect(result.complianceEnabled).toBe(true);
    });

    it('should enable SSO add-on', async () => {
      const updateInput: UpdateEntitlementInput = {
        ssoEnabled: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_sso',
        tenantId: 'tenant_sso',
        ssoEnabled: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_sso', updateInput);

      expect(result.ssoEnabled).toBe(true);
    });

    it('should enable multiple add-ons at once', async () => {
      const updateInput: UpdateEntitlementInput = {
        advancedAnalyticsEnabled: true,
        prioritySupportEnabled: true,
        complianceEnabled: true,
        ssoEnabled: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_multi',
        tenantId: 'tenant_multi',
        advancedAnalyticsEnabled: true,
        prioritySupportEnabled: true,
        complianceEnabled: true,
        ssoEnabled: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_multi', updateInput);

      expect(result.advancedAnalyticsEnabled).toBe(true);
      expect(result.prioritySupportEnabled).toBe(true);
      expect(result.complianceEnabled).toBe(true);
      expect(result.ssoEnabled).toBe(true);
    });
  });
});

// Tests for autonomous agent features (add-ons)
describe('Autonomous Agent Features (Add-ons)', () => {
  let entitlementService: EntitlementService;
  let mockRepository: jest.Mocked<EntitlementRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRepository = {
      findByTenantId: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<EntitlementRepository>;

    (EntitlementRepository as jest.Mock).mockImplementation(() => mockRepository);
    entitlementService = new EntitlementService();
  });

  describe('Autonomous feature updates', () => {
    it('should update autonomous feature flags', async () => {
      const updateInput: UpdateEntitlementInput = {
        scheduledAgentsEnabled: true,
        agentDelegationEnabled: true,
        crossAgentLearningEnabled: false,
        autoReflectionEnabled: true,
      };

      const updatedEntitlement = createMockEntitlement({
        id: 'ent_auto_1',
        tenantId: 'tenant_auto',
        scheduledAgentsEnabled: true,
        agentDelegationEnabled: true,
        crossAgentLearningEnabled: false,
        autoReflectionEnabled: true,
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedEntitlement);

      const result = await entitlementService.update('tenant_auto', updateInput);

      expect(mockRepository.update).toHaveBeenCalledWith('tenant_auto', updateInput);
      expect(result.scheduledAgentsEnabled).toBe(true);
      expect(result.agentDelegationEnabled).toBe(true);
      expect(result.crossAgentLearningEnabled).toBe(false);
    });
  });

  describe('Feature flag scenarios', () => {
    it('should check scheduledAgentsEnabled flag', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_enforce',
        tenantId: 'tenant_enforce',
        scheduledAgentsEnabled: true,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_enforce');

      expect(result?.scheduledAgentsEnabled).toBe(true);
    });

    it('should check agentDelegationEnabled flag', async () => {
      const entitlement = createMockEntitlement({
        id: 'ent_depth',
        tenantId: 'tenant_depth',
        agentDelegationEnabled: true,
      });

      mockRepository.findByTenantId.mockResolvedValue(entitlement);

      const result = await entitlementService.getByTenantId('tenant_depth');

      expect(result?.agentDelegationEnabled).toBe(true);
    });
  });
});

// Test helper constants
import { TEAM_TIERS, BASE_PRICE_PER_TEAM_YEARLY, BASE_PRICE_PER_TEAM_MONTHLY } from './types';

describe('Team capacity helpers', () => {
  describe('TEAM_TIERS', () => {
    it('should have correct tier values', () => {
      expect(TEAM_TIERS).toEqual([5, 10, 25, 50, 75, 100, 200]);
    });
  });

  describe('Pricing constants', () => {
    it('should have correct base prices', () => {
      expect(BASE_PRICE_PER_TEAM_YEARLY).toBe(250);
      expect(BASE_PRICE_PER_TEAM_MONTHLY).toBe(300);
    });
  });
});
