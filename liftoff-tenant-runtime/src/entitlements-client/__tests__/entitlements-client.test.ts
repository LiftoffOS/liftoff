// Entitlements Client Service Unit Tests
// Tests entitlement checks against control plane, caching, and convenience functions

import {
  EntitlementsClient,
  getEntitlementsClient,
  isExecutionAllowed,
  getOperationalStatus,
  isFeatureEnabled,
} from '../service';
import { pool } from '../../infrastructure/database';
import {
  TenantEntitlement,
  TenantQuotas,
  ApprovedDeployment,
  ModelConfig,
  PromptBundle,
  FeatureFlags,
  CacheConfig,
  DEFAULT_CACHE_CONFIG,
} from '../types';

// Mock dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');

const _mockPool = pool as jest.Mocked<typeof pool>;

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ==========================================
// Mock Factories
// ==========================================

function createMockEntitlement(overrides: Partial<TenantEntitlement> = {}): TenantEntitlement {
  return {
    tenantId: 'tenant-test-456',
    operationalStatus: 'active',
    agentExecutionAllowed: true,
    billingSuspended: false,
    remainingIncludedCredits: 5000,
    overageAllowed: true,
    includedMonthlyCredits: 10000,
    overageCeiling: 5000,
    entityVersion: 1,
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createMockQuotas(overrides: Partial<TenantQuotas> = {}): TenantQuotas {
  return {
    tenantId: 'tenant-test-456',
    operationalStatus: 'active',
    agentExecutionAllowed: true,
    billingSuspended: false,
    remainingIncludedCredits: 5000,
    overageAllowed: true,
    includedMonthlyCredits: 10000,
    overageCeiling: 5000,
    entityVersion: 1,
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createMockDeployment(overrides: Partial<ApprovedDeployment> = {}): ApprovedDeployment {
  return {
    deploymentId: 'deploy-test-123',
    tenantId: 'tenant-test-456',
    artifactRef: 'gs://bucket/artifacts/v1.0.0',
    version: '1.0.0',
    status: 'active',
    approvedAt: new Date('2024-01-01T00:00:00Z'),
    entityVersion: 1,
    ...overrides,
  };
}

function createMockModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'config-test-789',
    tenantId: 'tenant-test-456',
    modelId: 'claude-3-opus',
    routingPolicy: {
      defaultModel: 'claude-3-opus',
      taskOverrides: {
        summarization: 'claude-3-sonnet',
        simple_qa: 'claude-3-haiku',
      },
    },
    version: 1,
    entityVersion: 1,
    ...overrides,
  };
}

function createMockPromptBundle(overrides: Partial<PromptBundle> = {}): PromptBundle {
  return {
    bundleId: 'bundle-test-123',
    tenantId: 'tenant-test-456',
    name: 'Default Prompts',
    version: 1,
    status: 'approved',
    templates: {
      system_prompt: 'You are a helpful assistant.',
      error_prompt: 'An error occurred: {{error}}',
    },
    approvedAt: new Date('2024-01-01T00:00:00Z'),
    entityVersion: 1,
    ...overrides,
  };
}

function createMockFeatureFlags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    tenantId: 'tenant-test-456',
    flags: {
      new_ui_enabled: true,
      max_tokens: 4096,
      beta_features: 'enabled',
    },
    entityVersion: 1,
    ...overrides,
  };
}

function _entitlementToDbRow(entitlement: TenantEntitlement): Record<string, any> {
  return {
    tenant_id: entitlement.tenantId,
    operational_status: entitlement.operationalStatus,
    agent_execution_allowed: entitlement.agentExecutionAllowed,
    billing_suspended: entitlement.billingSuspended,
    remaining_credits: entitlement.remainingIncludedCredits,
    overage_allowed: entitlement.overageAllowed,
    included_monthly_credits: entitlement.includedMonthlyCredits,
    overage_ceiling: entitlement.overageCeiling,
    entity_version: entitlement.entityVersion,
    updated_at: entitlement.updatedAt,
  };
}

// ==========================================
// EntitlementsClient Tests
// ==========================================

describe('EntitlementsClient', () => {
  let client: EntitlementsClient;
  let mockRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();

    client = new EntitlementsClient();

    // Setup mock repository
    mockRepository = {
      getEntitlement: jest.fn().mockResolvedValue(createMockEntitlement()),
      isCacheStale: jest.fn().mockResolvedValue(false),
      upsertEntitlementFromEvent: jest.fn().mockResolvedValue(undefined),
      upsertEntitlementFromFetch: jest.fn().mockResolvedValue(undefined),
      getQuotas: jest.fn().mockResolvedValue(createMockQuotas()),
      getApprovedDeployment: jest.fn().mockResolvedValue(createMockDeployment()),
      getModelConfigs: jest.fn().mockResolvedValue([createMockModelConfig()]),
      getPromptBundle: jest.fn().mockResolvedValue(createMockPromptBundle()),
      getApprovedPromptBundles: jest.fn().mockResolvedValue([createMockPromptBundle()]),
      getFeatureFlags: jest.fn().mockResolvedValue(createMockFeatureFlags()),
      getStoredVersion: jest.fn().mockResolvedValue(null),
    };
    (client as any).repository = mockRepository;
  });

  // ==========================================
  // Entitlement Retrieval Tests
  // ==========================================

  describe('getEntitlement', () => {
    it('should return cached entitlement when available', async () => {
      const result = await client.getEntitlement('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(result.operationalStatus).toBe('active');
      expect(mockRepository.getEntitlement).toHaveBeenCalledWith('tenant-test-456');
    });

    it('should fetch from control plane when cache is stale', async () => {
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          includedMonthlyCredits: 10000,
          overageCeiling: 5000,
          entityVersion: 2,
        }),
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalled();
      // The FETCH variant, not the event one: a control-plane read is current
      // truth and must not be filtered by a version comparison.
      expect(mockRepository.upsertEntitlementFromFetch).toHaveBeenCalled();
      expect(mockRepository.upsertEntitlementFromEvent).not.toHaveBeenCalled();
    });

    it('caches the control plane snapshot even when entityVersion has not moved', async () => {
      // The exact live failure: the control plane serves the same version on
      // every read, so a version-guarded write matched nothing and the cache
      // sat months stale while every fetch logged success.
      mockRepository.getEntitlement.mockResolvedValueOnce(
        createMockEntitlement({ entityVersion: 1, updatedAt: new Date('2026-04-01T00:00:00Z') }),
      );
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          entityVersion: 1,
        }),
      });

      await client.getEntitlement('tenant-test-456');

      expect(mockRepository.upsertEntitlementFromFetch).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-test-456', entityVersion: 1 }),
      );
    });

    it('reads the entity version from the control plane `version` field', async () => {
      // The control plane serves the entitlement row's optimistic-lock counter
      // as `version`; `entityVersion` is the EVENT-envelope spelling and has
      // never appeared on this endpoint. Reading only the latter meant
      // `data.entityVersion || 1` was 1 on every fetch for every tenant, which
      // is what pinned the cached rows at v=1 and made the (then
      // version-guarded) write a permanent no-op.
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          version: 42,
        }),
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result.entityVersion).toBe(42);
      expect(mockRepository.upsertEntitlementFromFetch).toHaveBeenCalledWith(
        expect.objectContaining({ entityVersion: 42 }),
      );
    });

    it('still accepts the entityVersion spelling, so both shapes work', async () => {
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          entityVersion: 9,
        }),
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result.entityVersion).toBe(9);
    });

    it('defaults billingSuspended to false when the control plane omits it', async () => {
      // PB deploys before TR: during the rollout window the served snapshot has
      // no such field. Absent must read as "not suspended", never as suspended.
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          entityVersion: 2,
        }),
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result.billingSuspended).toBe(false);
    });

    it('carries billingSuspended through from the control plane snapshot', async () => {
      mockRepository.isCacheStale.mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
          billingSuspended: true,
          remainingIncludedCredits: 4000,
          overageAllowed: true,
          entityVersion: 2,
        }),
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result.billingSuspended).toBe(true);
      expect(mockRepository.upsertEntitlementFromFetch).toHaveBeenCalledWith(
        expect.objectContaining({ billingSuspended: true }),
      );
    });

    it('should return default quotas when no entitlement found', async () => {
      mockRepository.getEntitlement.mockResolvedValueOnce(null);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await client.getEntitlement('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(result.agentExecutionAllowed).toBe(false); // Default
    });
  });

  // ==========================================
  // Quota Tests
  // ==========================================

  describe('getQuotas', () => {
    it('should return full quotas for tenant', async () => {
      const result = await client.getQuotas('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.includedMonthlyCredits).toBe(10000);
      expect(result.overageCeiling).toBe(5000);
    });

    it('should return default quotas when not found', async () => {
      mockRepository.getQuotas.mockResolvedValueOnce(null);

      const result = await client.getQuotas('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      // Should use default values
      expect(result.agentExecutionAllowed).toBe(false);
    });
  });

  // ==========================================
  // Operational Status Tests
  // ==========================================

  describe('getOperationalStatus', () => {
    it('should return active status', async () => {
      const result = await client.getOperationalStatus('tenant-test-456');

      expect(result).toBe('active');
    });

    it('should return suspended status', async () => {
      mockRepository.getEntitlement.mockResolvedValueOnce(
        createMockEntitlement({ operationalStatus: 'suspended' })
      );

      const result = await client.getOperationalStatus('tenant-test-456');

      expect(result).toBe('suspended');
    });
  });

  describe('isExecutionAllowed', () => {
    it('should return true when active and allowed', async () => {
      const result = await client.isExecutionAllowed('tenant-test-456');

      expect(result).toBe(true);
    });

    it('should return false when suspended', async () => {
      mockRepository.getEntitlement.mockResolvedValueOnce(
        createMockEntitlement({
          operationalStatus: 'suspended',
          agentExecutionAllowed: false,
        })
      );

      const result = await client.isExecutionAllowed('tenant-test-456');

      expect(result).toBe(false);
    });

    it('should return false when execution not allowed', async () => {
      mockRepository.getEntitlement.mockResolvedValueOnce(
        createMockEntitlement({
          operationalStatus: 'active',
          agentExecutionAllowed: false,
        })
      );

      const result = await client.isExecutionAllowed('tenant-test-456');

      expect(result).toBe(false);
    });
  });

  // ==========================================
  // Deployment Tests
  // ==========================================

  describe('getApprovedDeployment', () => {
    it('should return approved deployment', async () => {
      const result = await client.getApprovedDeployment('tenant-test-456');

      expect(result).toBeDefined();
      expect(result?.deploymentId).toBe('deploy-test-123');
      expect(result?.version).toBe('1.0.0');
    });

    it('should return null when no deployment found', async () => {
      mockRepository.getApprovedDeployment.mockResolvedValueOnce(null);

      const result = await client.getApprovedDeployment('tenant-test-456');

      expect(result).toBeNull();
    });
  });

  // ==========================================
  // Model Config Tests
  // ==========================================

  describe('getModelConfigs', () => {
    it('should return model configs', async () => {
      const result = await client.getModelConfigs('tenant-test-456');

      expect(result).toHaveLength(1);
      expect(result[0].modelId).toBe('claude-3-opus');
    });
  });

  describe('getModelForTask', () => {
    it('should return task-specific model override', async () => {
      const result = await client.getModelForTask('tenant-test-456', 'summarization');

      expect(result).toEqual({ model: 'claude-3-sonnet', provider: undefined });
    });

    it('should return default model for unknown task', async () => {
      const result = await client.getModelForTask('tenant-test-456', 'unknown_task');

      expect(result).toEqual({ model: 'claude-3-opus', provider: undefined });
    });

    it('should return null when no configs', async () => {
      mockRepository.getModelConfigs.mockResolvedValueOnce([]);

      const result = await client.getModelForTask('tenant-test-456', 'any_task');

      expect(result).toBeNull();
    });
  });

  // ==========================================
  // Prompt Bundle Tests
  // ==========================================

  describe('getPromptBundle', () => {
    it('should return specific prompt bundle', async () => {
      const result = await client.getPromptBundle('tenant-test-456', 'bundle-test-123');

      expect(result).toBeDefined();
      expect(result?.bundleId).toBe('bundle-test-123');
      expect(result?.templates.system_prompt).toBe('You are a helpful assistant.');
    });

    it('should return null when bundle not found', async () => {
      mockRepository.getPromptBundle.mockResolvedValueOnce(null);

      const result = await client.getPromptBundle('tenant-test-456', 'non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getApprovedPromptBundles', () => {
    it('should return all approved bundles', async () => {
      const result = await client.getApprovedPromptBundles('tenant-test-456');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('approved');
    });
  });

  // ==========================================
  // Feature Flag Tests
  // ==========================================

  describe('getFeatureFlags', () => {
    it('should return feature flags', async () => {
      const result = await client.getFeatureFlags('tenant-test-456');

      expect(result.new_ui_enabled).toBe(true);
      expect(result.max_tokens).toBe(4096);
    });

    it('should return empty object when no flags', async () => {
      mockRepository.getFeatureFlags.mockResolvedValueOnce(null);

      const result = await client.getFeatureFlags('tenant-test-456');

      expect(result).toEqual({});
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for enabled feature', async () => {
      const result = await client.isFeatureEnabled('tenant-test-456', 'new_ui_enabled');

      expect(result).toBe(true);
    });

    it('should return false for missing feature', async () => {
      const result = await client.isFeatureEnabled('tenant-test-456', 'non_existent_feature');

      expect(result).toBe(false);
    });
  });

  describe('getFeatureFlagValue', () => {
    it('should return feature flag value', async () => {
      const result = await client.getFeatureFlagValue<number>(
        'tenant-test-456',
        'max_tokens',
        1024
      );

      expect(result).toBe(4096);
    });

    it('should return default value when flag not found', async () => {
      const result = await client.getFeatureFlagValue<number>(
        'tenant-test-456',
        'non_existent',
        1024
      );

      expect(result).toBe(1024);
    });
  });

  // ==========================================
  // Credit Tests
  // ==========================================



  // ==========================================
  // Stale Event Rule Tests
  // ==========================================

  describe('isEventNewer', () => {
    it('should return true for first event', async () => {
      mockRepository.getStoredVersion.mockResolvedValueOnce(null);

      const result = await client.isEventNewer('tenant-test-456', 'agent', 'agent-1', 1);

      expect(result).toBe(true);
    });

    it('should return true when event version is newer', async () => {
      mockRepository.getStoredVersion.mockResolvedValueOnce(1);

      const result = await client.isEventNewer('tenant-test-456', 'agent', 'agent-1', 2);

      expect(result).toBe(true);
    });

    it('should return false when event version is older', async () => {
      mockRepository.getStoredVersion.mockResolvedValueOnce(3);

      const result = await client.isEventNewer('tenant-test-456', 'agent', 'agent-1', 2);

      expect(result).toBe(false);
    });

    it('should return false when event version is same', async () => {
      mockRepository.getStoredVersion.mockResolvedValueOnce(2);

      const result = await client.isEventNewer('tenant-test-456', 'agent', 'agent-1', 2);

      expect(result).toBe(false);
    });
  });

  // ==========================================
  // Migration State Tests
  // ==========================================

  describe('getMigrationState', () => {
    it('should return migration state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tenantId: 'tenant-test-456',
          migrationId: 'migration-123',
          status: 'in_progress',
          sourceInstance: 'us-west1',
          targetInstance: 'us-central1',
        }),
      });

      const result = await client.getMigrationState('tenant-test-456');

      expect(result).toBeDefined();
      expect(result?.status).toBe('in_progress');
    });

    it('should return null when no migration', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await client.getMigrationState('tenant-test-456');

      expect(result).toBeNull();
    });

    it('should handle fetch error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.getMigrationState('tenant-test-456');

      expect(result).toBeNull();
    });
  });

  // ==========================================
  // Cache Configuration Tests
  // ==========================================

  describe('cache configuration', () => {
    it('should use default cache config', () => {
      const defaultClient = new EntitlementsClient();

      expect((defaultClient as any).cacheConfig).toEqual(DEFAULT_CACHE_CONFIG);
    });

    it('should allow custom cache config', () => {
      const customConfig: Partial<CacheConfig> = {
        entitlementTtlMs: 30000,
        refreshOnMiss: false,
      };
      const customClient = new EntitlementsClient(customConfig);

      expect((customClient as any).cacheConfig.entitlementTtlMs).toBe(30000);
      expect((customClient as any).cacheConfig.refreshOnMiss).toBe(false);
    });
  });
});

// ==========================================
// Convenience Function Tests
// ==========================================

describe('Convenience Functions', () => {
  let mockRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the singleton client and set up its mock repository
    const client = getEntitlementsClient();
    mockRepository = {
      getEntitlement: jest.fn().mockResolvedValue(createMockEntitlement()),
      isCacheStale: jest.fn().mockResolvedValue(false),
      getQuotas: jest.fn().mockResolvedValue(createMockQuotas()),
      getFeatureFlags: jest.fn().mockResolvedValue(createMockFeatureFlags()),
    };
    (client as any).repository = mockRepository;
  });

  describe('isExecutionAllowed', () => {
    it('should check execution allowed via singleton', async () => {
      const result = await isExecutionAllowed('tenant-test-456');

      expect(result).toBe(true);
    });
  });

  describe('getOperationalStatus', () => {
    it('should get operational status via singleton', async () => {
      const result = await getOperationalStatus('tenant-test-456');

      expect(result).toBe('active');
    });
  });

  describe('isFeatureEnabled', () => {
    it('should check feature enabled via singleton', async () => {
      const result = await isFeatureEnabled('tenant-test-456', 'new_ui_enabled');

      expect(result).toBe(true);
    });
  });

});

// ==========================================
// Singleton Tests
// ==========================================

describe('getEntitlementsClient', () => {
  it('should return same instance on multiple calls', () => {
    const client1 = getEntitlementsClient();
    const client2 = getEntitlementsClient();

    expect(client1).toBe(client2);
  });
});
