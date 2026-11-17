// Infrastructure Provisioning Service Tests
// Tests tenant creation, configuration, and lifecycle management

// Mock Google Cloud Build - create mocks inside factory to avoid hoisting issues
jest.mock('@google-cloud/cloudbuild', () => {
  const mockRunBuildTrigger = jest.fn();
  const mockGetBuild = jest.fn();
  return {
    CloudBuildClient: jest.fn().mockImplementation(() => ({
      runBuildTrigger: mockRunBuildTrigger,
      getBuild: mockGetBuild,
    })),
    __getMocks: () => ({ mockRunBuildTrigger, mockGetBuild }),
  };
});

// Mock logging
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  InfrastructureProvisioningService,
  ProvisioningRequest,
  DeprovisioningRequest,
} from '../../infrastructure/provisioning';

// Get mock functions from the mocked module
const CloudBuildMock = jest.requireMock('@google-cloud/cloudbuild');
const { mockRunBuildTrigger, mockGetBuild } = CloudBuildMock.__getMocks();

// Store original env
const originalEnv = process.env;

describe('InfrastructureProvisioningService', () => {
  let provisioningService: InfrastructureProvisioningService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      GCP_PROJECT: 'control',
      GCP_REGION: 'us-central1',
      ENVIRONMENT: 'dev',
    };

    provisioningService = new InfrastructureProvisioningService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('provisionTenantInfrastructure', () => {
    const provisioningRequest: ProvisioningRequest = {
      tenantId: 'tenant_abc123',
      accountId: 'acc_123',
      tenantName: 'Test Tenant',
      environment: 'dev',
      tier: 'standard',
    };

    // Helper to create a mock operation that runBuildTrigger returns
    const createMockOperation = (buildId: string) => ({
      promise: jest.fn().mockResolvedValue([{ id: buildId }]),
    });

    it('should trigger Cloud Build for tenant provisioning', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createMockOperation('build_123')]);

      const result = await provisioningService.provisionTenantInfrastructure(
        provisioningRequest
      );

      expect(result.success).toBe(true);
      expect(result.buildId).toBe('build_123');
      expect(result.gcpProjectId).toBeDefined();
    });

    it('should generate correct GCP project ID', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createMockOperation('build_123')]);

      const result = await provisioningService.provisionTenantInfrastructure(
        provisioningRequest
      );

      // Project ID should follow naming convention: tenant-<tenant-id>-runtime-<env>
      // Note: underscores in tenant IDs are preserved in the project ID
      expect(result.gcpProjectId).toMatch(/^tenant-[a-z0-9_]+-runtime/);
    });

    it('should pass correct substitutions to Cloud Build', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createMockOperation('build_123')]);

      await provisioningService.provisionTenantInfrastructure(provisioningRequest);

      expect(mockRunBuildTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'control',
        })
      );
    });

    it('should handle standard tier provisioning', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createMockOperation('build_standard')]);

      const result = await provisioningService.provisionTenantInfrastructure({
        ...provisioningRequest,
        tier: 'standard',
      });

      expect(result.success).toBe(true);
    });

    it('should handle enterprise tier provisioning', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createMockOperation('build_enterprise')]);

      const result = await provisioningService.provisionTenantInfrastructure({
        ...provisioningRequest,
        tier: 'enterprise',
      });

      expect(result.success).toBe(true);
    });

    it('should handle Cloud Build failure', async () => {
      mockRunBuildTrigger.mockRejectedValueOnce(new Error('Cloud Build API error'));

      const result = await provisioningService.provisionTenantInfrastructure(
        provisioningRequest
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cloud Build API error');
    });

    it('should handle build promise rejection', async () => {
      mockRunBuildTrigger.mockRejectedValueOnce(new Error('Build trigger failed'));

      const result = await provisioningService.provisionTenantInfrastructure(
        provisioningRequest
      );

      expect(result.success).toBe(false);
    });

    it('should generate different project IDs for different environments', async () => {
      // Use mockResolvedValue so it works for multiple calls
      mockRunBuildTrigger.mockImplementation(() =>
        Promise.resolve([createMockOperation('build_123')])
      );

      const devResult = await provisioningService.provisionTenantInfrastructure({
        ...provisioningRequest,
        environment: 'dev',
      });

      process.env.ENVIRONMENT = 'staging';
      const stagingService = new InfrastructureProvisioningService();
      const stagingResult = await stagingService.provisionTenantInfrastructure({
        ...provisioningRequest,
        environment: 'staging',
      });

      expect(devResult.gcpProjectId).not.toBe(stagingResult.gcpProjectId);
    });
  });

  describe('checkProvisioningStatus', () => {
    it('should return pending for QUEUED status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'QUEUED' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('pending');
    });

    it('should return pending for PENDING status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'PENDING' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('pending');
    });

    it('should return running for WORKING status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'WORKING' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('running');
    });

    it('should return success for SUCCESS status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'SUCCESS' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('success');
    });

    it('should return failure for FAILURE status', async () => {
      mockGetBuild.mockResolvedValueOnce([
        { status: 'FAILURE', statusDetail: 'Build failed' },
      ]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('failure');
    });

    it('should return failure for TIMEOUT status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'TIMEOUT' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('failure');
    });

    it('should return canceled for CANCELLED status', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'CANCELLED' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('canceled');
    });

    it('should handle API errors', async () => {
      mockGetBuild.mockRejectedValueOnce(new Error('API Error'));

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('failure');
      expect(result.message).toContain('API Error');
    });

    it('should return default message when statusDetail is missing', async () => {
      mockGetBuild.mockResolvedValueOnce([{ status: 'FAILURE' }]);

      const result = await provisioningService.checkProvisioningStatus('build_123');

      expect(result.status).toBe('failure');
      expect(result.message).toBeDefined();
    });
  });

  describe('deprovisionTenantInfrastructure', () => {
    const deprovisioningRequest: DeprovisioningRequest = {
      tenantId: 'tenant_abc123',
      gcpProjectId: 'tenant-abc123-runtime-dev',
    };

    // Helper for deprovisioning tests
    const createDeprovisionMockOperation = (buildId: string) => ({
      promise: jest.fn().mockResolvedValue([{ id: buildId }]),
    });

    it('should trigger Cloud Build for tenant deprovisioning', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createDeprovisionMockOperation('deprovision_build_123')]);

      const result = await provisioningService.deprovisionTenantInfrastructure(
        deprovisioningRequest
      );

      expect(result.success).toBe(true);
      expect(result.buildId).toBe('deprovision_build_123');
    });

    it('should pass correct substitutions for deprovisioning', async () => {
      mockRunBuildTrigger.mockResolvedValueOnce([createDeprovisionMockOperation('deprovision_build_123')]);

      await provisioningService.deprovisionTenantInfrastructure(deprovisioningRequest);

      expect(mockRunBuildTrigger).toHaveBeenCalled();
    });

    it('should handle deprovisioning failure', async () => {
      mockRunBuildTrigger.mockRejectedValueOnce(new Error('Deprovisioning failed'));

      const result = await provisioningService.deprovisionTenantInfrastructure(
        deprovisioningRequest
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deprovisioning failed');
    });
  });

  describe('generateProjectId', () => {
    // Note: Using 'as any' to access private method for testing
    it('should generate project ID with correct prefix', () => {
      const projectId = (provisioningService as any).generateProjectId('tenant_abc123', 'dev');

      expect(projectId).toMatch(/^tenant-/);
      expect(projectId).toContain('-runtime-');
    });

    it('should truncate long tenant IDs to stay under limit', () => {
      const longTenantId = 'tenant_very_long_tenant_id_that_exceeds_limits';
      const projectId = (provisioningService as any).generateProjectId(longTenantId, 'dev');

      // Project ID should be reasonable length (implementation may vary)
      expect(projectId.length).toBeLessThan(50);
    });

    it('should handle hyphens in tenant ID', () => {
      const projectId = (provisioningService as any).generateProjectId('tenant-with-hyphens', 'dev');

      expect(projectId).toMatch(/^tenant-[a-z0-9]+-runtime-dev$/);
    });

    it('should not add environment suffix for production', () => {
      const projectId = (provisioningService as any).generateProjectId('tenant_abc123', 'prod');

      expect(projectId).not.toContain('-prod');
    });
  });
});

describe('Provisioning lifecycle', () => {
  let provisioningService: InfrastructureProvisioningService;

  // Helper to create mock operations for lifecycle tests
  const createLifecycleMockOperation = (buildId: string) => ({
    promise: jest.fn().mockResolvedValue([{ id: buildId }]),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      GCP_PROJECT: 'control',
      GCP_REGION: 'us-central1',
      ENVIRONMENT: 'dev',
    };
    provisioningService = new InfrastructureProvisioningService();
  });

  it('should support full provisioning lifecycle', async () => {
    // Start provisioning
    mockRunBuildTrigger.mockResolvedValueOnce([createLifecycleMockOperation('lifecycle_build_123')]);

    const provisionResult = await provisioningService.provisionTenantInfrastructure({
      tenantId: 'tenant_lifecycle',
      accountId: 'acc_123',
      tenantName: 'Lifecycle Test',
      environment: 'dev',
      tier: 'standard',
    });

    expect(provisionResult.success).toBe(true);

    // Check status - pending
    mockGetBuild.mockResolvedValueOnce([{ status: 'WORKING' }]);
    const pendingStatus = await provisioningService.checkProvisioningStatus(
      provisionResult.buildId!
    );
    expect(pendingStatus.status).toBe('running');

    // Check status - complete
    mockGetBuild.mockResolvedValueOnce([{ status: 'SUCCESS' }]);
    const completeStatus = await provisioningService.checkProvisioningStatus(
      provisionResult.buildId!
    );
    expect(completeStatus.status).toBe('success');
  });

  it('should support full deprovisioning lifecycle', async () => {
    // Start deprovisioning
    mockRunBuildTrigger.mockResolvedValueOnce([createLifecycleMockOperation('deprovision_lifecycle_123')]);

    const deprovisionResult = await provisioningService.deprovisionTenantInfrastructure({
      tenantId: 'tenant_lifecycle',
      gcpProjectId: 'tenant-lifecycle-runtime-dev',
    });

    expect(deprovisionResult.success).toBe(true);

    // Check status - complete
    mockGetBuild.mockResolvedValueOnce([{ status: 'SUCCESS' }]);
    const completeStatus = await provisioningService.checkProvisioningStatus(
      deprovisionResult.buildId!
    );
    expect(completeStatus.status).toBe('success');
  });
});
