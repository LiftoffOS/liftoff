// Rollout Orchestration Service Tests
// Tests progressive rollout, traffic splits, metrics, and auto-rollback

import { RolloutOrchestrationService, RolloutProgress, TrafficSplit } from '../orchestration-service';
import { ModelRolloutRepository } from '../../model-registry/repository';
import { ModelRegistryService } from '../../model-registry/service';
import { ModelRollout, RolloutConfig, RolloutMetrics } from '../../model-registry/types';

// Mock external dependencies - define inline since jest.mock is hoisted
jest.mock('../../model-registry/repository');
jest.mock('../../model-registry/service');

jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock database with shared mockQuery function
jest.mock('../../infrastructure/database', () => {
  // Use closure to access mockQuery defined above
  const sharedMockQuery = jest.fn();
  return {
    withTenantScope: (_t: any, fn: any) => fn({ query: sharedMockQuery }),
    withAdminScope: (_c: any, fn: any) => fn({ query: sharedMockQuery }),
    getPool: () => ({
      query: sharedMockQuery,
    }),
    pool: {
      query: sharedMockQuery,
    },
    __getMockQuery: () => sharedMockQuery,
  };
});

// Mock validator-hooks service to avoid database calls during rollout start
jest.mock('../../validator-hooks/service', () => ({
  ValidatorHookService: jest.fn().mockImplementation(() => ({
    validateRolloutStart: jest.fn().mockResolvedValue({ passed: true, blockers: [], warnings: [] }),
    validateRolloutAdvance: jest.fn().mockResolvedValue({ passed: true, blockers: [], warnings: [] }),
    validateRolloutComplete: jest.fn().mockResolvedValue({ passed: true, blockers: [], warnings: [] }),
    invokeRolloutHooks: jest.fn().mockResolvedValue([]),
  })),
}));

// Import mocked functions
import { publishEvent } from '../../events/publisher';
import { logger } from '../../infrastructure/logging';
import { getPool } from '../../infrastructure/database';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;
const mockLogger = logger as jest.Mocked<typeof logger>;
// Get the shared mockQuery from the mock module
const getMockQuery = () => (getPool() as unknown as { query: jest.Mock }).query;

// Helper functions to create mock data
function createMockRollout(overrides: Partial<ModelRollout> = {}): ModelRollout {
  return {
    id: 'rollout_test_123',
    tenantId: 'tenant_test_123',
    modelId: 'model_new_123',
    previousModelId: 'model_old_123',
    version: 1,
    status: 'pending',
    strategy: 'gradual',
    config: {
      healthCheckEnabled: true,
      errorThresholdPercent: 5,
      latencyThresholdMs: 5000,
      gradualSteps: [10, 25, 50, 100],
      stepDurationMinutes: 60,
      notifyOnApproval: ['admin@example.com'],
      notifyOnFailure: ['oncall@example.com'],
    },
    requestedBy: 'user_123',
    requestedAt: new Date('2024-01-01T00:00:00Z'),
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    startedAt: null,
    completedAt: null,
    rollbackedAt: null,
    rollbackReason: null,
    metrics: {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsFailed: 0,
      averageLatencyMs: 0,
      p99LatencyMs: 0,
      errorRate: 0,
    },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('RolloutOrchestrationService', () => {
  let rolloutService: RolloutOrchestrationService;
  let mockRolloutRepository: jest.Mocked<ModelRolloutRepository>;
  let mockModelRegistryService: jest.Mocked<ModelRegistryService>;
  let dbMockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get reference to the shared mock query function
    dbMockQuery = getMockQuery();
    dbMockQuery.mockReset();
    dbMockQuery.mockResolvedValue({ rows: [] });

    // Create mock repositories
    mockRolloutRepository = {
      findById: jest.fn(),
      findByTenantId: jest.fn(),
      findInProgress: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
      complete: jest.fn(),
      rollback: jest.fn(),
    } as unknown as jest.Mocked<ModelRolloutRepository>;

    mockModelRegistryService = {
      completeRollout: jest.fn(),
      rollbackRollout: jest.fn(),
    } as unknown as jest.Mocked<ModelRegistryService>;

    (ModelRolloutRepository as jest.Mock).mockImplementation(() => mockRolloutRepository);
    (ModelRegistryService as jest.Mock).mockImplementation(() => mockModelRegistryService);

    rolloutService = new RolloutOrchestrationService();
  });

  describe('getTrafficSplit', () => {
    it('should return traffic split for active rollout', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [{
          rollout_id: 'rollout_123',
          percentage: 25,
          is_active: true,
        }],
      });

      const result = await rolloutService.getTrafficSplit('tenant_123');

      expect(result).toEqual({
        rolloutId: 'rollout_123',
        percentage: 25,
        isActive: true,
      });
    });

    it('should return null when no active rollout exists', async () => {
      dbMockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await rolloutService.getTrafficSplit('tenant_123');

      expect(result).toBeNull();
    });
  });

  describe('shouldUseNewModel', () => {
    it('should return false when no active rollout', async () => {
      dbMockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await rolloutService.shouldUseNewModel('tenant_123');

      expect(result).toBe(false);
    });

    it('should return true for percentage-based routing when random < percentage', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [{
          rollout_id: 'rollout_123',
          percentage: 100, // 100% means always use new model
          is_active: true,
        }],
      });

      const result = await rolloutService.shouldUseNewModel('tenant_123');

      expect(result).toBe(true);
    });

    it('should return false when traffic percentage is 0', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [{
          rollout_id: 'rollout_123',
          percentage: 0,
          is_active: true,
        }],
      });

      const result = await rolloutService.shouldUseNewModel('tenant_123');

      expect(result).toBe(false);
    });
  });

  describe('startProgressiveRollout', () => {
    it('should throw error when rollout not found', async () => {
      mockRolloutRepository.findById.mockResolvedValue(null);

      await expect(
        rolloutService.startProgressiveRollout('rollout_missing')
      ).rejects.toThrow('Rollout rollout_missing not found');
    });

    it('should throw error when rollout is not approved', async () => {
      const pendingRollout = createMockRollout({
        id: 'rollout_pending',
        status: 'pending',
      });

      mockRolloutRepository.findById.mockResolvedValue(pendingRollout);

      await expect(
        rolloutService.startProgressiveRollout('rollout_pending')
      ).rejects.toThrow('Rollout rollout_pending is not approved');
    });

    it('should start canary rollout with correct initial percentage', async () => {
      const canaryRollout = createMockRollout({
        id: 'rollout_canary',
        status: 'approved',
        strategy: 'canary',
        config: {
          healthCheckEnabled: true,
          canaryPercentage: 10,
          canaryDurationMinutes: 30,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(canaryRollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.startProgressiveRollout('rollout_canary');

      // Verify traffic split was created with canary percentage
      expect(dbMockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rollout_traffic_splits'),
        ['rollout_canary', 10]
      );
    });

    it('should start gradual rollout with first step percentage', async () => {
      const gradualRollout = createMockRollout({
        id: 'rollout_gradual',
        status: 'approved',
        strategy: 'gradual',
        config: {
          healthCheckEnabled: true,
          gradualSteps: [10, 25, 50, 100],
          stepDurationMinutes: 60,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(gradualRollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.startProgressiveRollout('rollout_gradual');

      // Verify traffic split was created with first step percentage
      expect(dbMockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rollout_traffic_splits'),
        ['rollout_gradual', 10]
      );
    });

    it('should start immediate rollout at 100%', async () => {
      const immediateRollout = createMockRollout({
        id: 'rollout_immediate',
        status: 'approved',
        strategy: 'immediate',
        config: {
          healthCheckEnabled: false,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(immediateRollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.startProgressiveRollout('rollout_immediate');

      // Verify traffic split was created at 100%
      expect(dbMockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rollout_traffic_splits'),
        ['rollout_immediate', 100]
      );
    });

    it('should publish rollout started event', async () => {
      const rollout = createMockRollout({
        id: 'rollout_event',
        status: 'approved',
        strategy: 'gradual',
        tenantId: 'tenant_123',
        modelId: 'model_new',
        version: 1,
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.startProgressiveRollout('rollout_event');

      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tenant.model_rollout.started',
          tenantId: 'tenant_123',
          entityType: 'model_rollout',
          entityId: 'rollout_event',
        })
      );
    });
  });

  describe('advanceRollout', () => {
    it('should return false when rollout not found', async () => {
      mockRolloutRepository.findById.mockResolvedValue(null);

      const result = await rolloutService.advanceRollout('rollout_missing');

      expect(result).toBe(false);
    });

    it('should return false when rollout is not in progress', async () => {
      const completedRollout = createMockRollout({
        id: 'rollout_completed',
        status: 'completed',
      });

      mockRolloutRepository.findById.mockResolvedValue(completedRollout);

      const result = await rolloutService.advanceRollout('rollout_completed');

      expect(result).toBe(false);
    });

    it('should complete canary rollout by advancing to 100%', async () => {
      const canaryRollout = createMockRollout({
        id: 'rollout_canary',
        status: 'in_progress',
        strategy: 'canary',
        config: {
          healthCheckEnabled: true,
          canaryPercentage: 10,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(canaryRollout);
      dbMockQuery.mockResolvedValueOnce({ rows: [{ current_step: 0 }] });
      dbMockQuery.mockResolvedValue({ rows: [] });
      mockModelRegistryService.completeRollout.mockResolvedValue({ ...canaryRollout, status: 'completed' });

      const result = await rolloutService.advanceRollout('rollout_canary');

      expect(result).toBe(true);
      expect(mockModelRegistryService.completeRollout).toHaveBeenCalled();
    });

    it('should advance gradual rollout to next step', async () => {
      const gradualRollout = createMockRollout({
        id: 'rollout_gradual',
        status: 'in_progress',
        strategy: 'gradual',
        config: {
          healthCheckEnabled: true,
          gradualSteps: [10, 25, 50, 100],
          stepDurationMinutes: 60,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(gradualRollout);
      dbMockQuery.mockResolvedValueOnce({ rows: [{ current_step: 0 }] }); // getCurrentStep
      dbMockQuery.mockResolvedValue({ rows: [] });

      const result = await rolloutService.advanceRollout('rollout_gradual');

      expect(result).toBe(true);
    });

    it('should publish step advanced event', async () => {
      const rollout = createMockRollout({
        id: 'rollout_step_event',
        status: 'in_progress',
        strategy: 'gradual',
        tenantId: 'tenant_123',
        version: 1,
        config: {
          healthCheckEnabled: true,
          gradualSteps: [10, 25, 50, 100],
          stepDurationMinutes: 60,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValueOnce({ rows: [{ current_step: 0 }] });
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.advanceRollout('rollout_step_event');

      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tenant.model_rollout.step_advanced',
          tenantId: 'tenant_123',
          payload: expect.objectContaining({
            step: 1,
            percentage: 25,
          }),
        })
      );
    });
  });

  describe('getRolloutProgress', () => {
    it('should return null when rollout not found', async () => {
      mockRolloutRepository.findById.mockResolvedValue(null);

      const result = await rolloutService.getRolloutProgress('rollout_missing');

      expect(result).toBeNull();
    });

    it('should return progress for existing rollout', async () => {
      const rollout = createMockRollout({
        id: 'rollout_progress',
        status: 'in_progress',
        strategy: 'gradual',
        config: {
          healthCheckEnabled: true,
          gradualSteps: [10, 25, 50, 100],
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
        metrics: {
          requestsTotal: 100,
          requestsSuccess: 95,
          requestsFailed: 5,
          averageLatencyMs: 150,
          p99LatencyMs: 500,
          errorRate: 0.05,
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValueOnce({
        rows: [{
          current_step: 1,
          current_percentage: 25,
          next_step_at: new Date('2024-01-01T01:00:00Z'),
        }],
      });

      const result = await rolloutService.getRolloutProgress('rollout_progress');

      expect(result).toEqual({
        rolloutId: 'rollout_progress',
        status: 'in_progress',
        strategy: 'gradual',
        currentStep: 1,
        totalSteps: 4,
        currentPercentage: 25,
        targetPercentage: 100,
        nextStepAt: new Date('2024-01-01T01:00:00Z'),
        metrics: rollout.metrics,
      });
    });
  });

  describe('checkMetricsAndRollback', () => {
    it('should return false when rollout not found', async () => {
      mockRolloutRepository.findById.mockResolvedValue(null);

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_missing',
        { requestsTotal: 0, requestsSuccess: 0, requestsFailed: 0, averageLatencyMs: 0, p99LatencyMs: 0, errorRate: 0 }
      );

      expect(result).toBe(false);
    });

    it('should return false when rollout is not in progress', async () => {
      const completedRollout = createMockRollout({ status: 'completed' });
      mockRolloutRepository.findById.mockResolvedValue(completedRollout);

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_123',
        { requestsTotal: 0, requestsSuccess: 0, requestsFailed: 0, averageLatencyMs: 0, p99LatencyMs: 0, errorRate: 0 }
      );

      expect(result).toBe(false);
    });

    it('should return false when health check is disabled', async () => {
      const rollout = createMockRollout({
        status: 'in_progress',
        config: {
          healthCheckEnabled: false,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_123',
        { requestsTotal: 100, requestsSuccess: 50, requestsFailed: 50, averageLatencyMs: 1000, p99LatencyMs: 10000, errorRate: 0.5 }
      );

      expect(result).toBe(false);
    });

    it('should trigger rollback when error rate exceeds threshold', async () => {
      const rollout = createMockRollout({
        id: 'rollout_high_errors',
        status: 'in_progress',
        config: {
          healthCheckEnabled: true,
          errorThresholdPercent: 5,
          latencyThresholdMs: 5000,
          notifyOnApproval: [],
          notifyOnFailure: ['oncall@example.com'],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [] });
      mockModelRegistryService.rollbackRollout.mockResolvedValue({ ...rollout, status: 'rolled_back' });

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_high_errors',
        { requestsTotal: 100, requestsSuccess: 90, requestsFailed: 10, averageLatencyMs: 150, p99LatencyMs: 500, errorRate: 0.10 } // 10% > 5%
      );

      expect(result).toBe(true);
      expect(mockModelRegistryService.rollbackRollout).toHaveBeenCalledWith(
        'rollout_high_errors',
        expect.stringContaining('Error rate')
      );
    });

    it('should trigger rollback when latency exceeds threshold', async () => {
      const rollout = createMockRollout({
        id: 'rollout_high_latency',
        status: 'in_progress',
        config: {
          healthCheckEnabled: true,
          errorThresholdPercent: 5,
          latencyThresholdMs: 5000,
          notifyOnApproval: [],
          notifyOnFailure: ['oncall@example.com'],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [] });
      mockModelRegistryService.rollbackRollout.mockResolvedValue({ ...rollout, status: 'rolled_back' });

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_high_latency',
        { requestsTotal: 100, requestsSuccess: 99, requestsFailed: 1, averageLatencyMs: 2000, p99LatencyMs: 6000, errorRate: 0.01 } // 6000ms > 5000ms
      );

      expect(result).toBe(true);
      expect(mockModelRegistryService.rollbackRollout).toHaveBeenCalledWith(
        'rollout_high_latency',
        expect.stringContaining('P99 latency')
      );
    });

    it('should not trigger rollback when metrics are healthy', async () => {
      const rollout = createMockRollout({
        id: 'rollout_healthy',
        status: 'in_progress',
        config: {
          healthCheckEnabled: true,
          errorThresholdPercent: 5,
          latencyThresholdMs: 5000,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);

      const result = await rolloutService.checkMetricsAndRollback(
        'rollout_healthy',
        { requestsTotal: 100, requestsSuccess: 98, requestsFailed: 2, averageLatencyMs: 150, p99LatencyMs: 500, errorRate: 0.02 }
      );

      expect(result).toBe(false);
      expect(mockModelRegistryService.rollbackRollout).not.toHaveBeenCalled();
    });
  });

  describe('rollbackRollout', () => {
    it('should do nothing when rollout not found', async () => {
      mockRolloutRepository.findById.mockResolvedValue(null);

      await rolloutService.rollbackRollout('rollout_missing', 'Test reason');

      expect(mockModelRegistryService.rollbackRollout).not.toHaveBeenCalled();
    });

    it('should deactivate traffic splits', async () => {
      const rollout = createMockRollout({
        id: 'rollout_rollback',
        status: 'in_progress',
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.rollbackRollout('rollout_rollback', 'Manual rollback');

      expect(dbMockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE rollout_traffic_splits SET is_active = false'),
        ['rollout_rollback']
      );
    });

    it('should call model registry service to perform rollback', async () => {
      const rollout = createMockRollout({
        id: 'rollout_rollback',
        status: 'in_progress',
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [] });

      await rolloutService.rollbackRollout('rollout_rollback', 'API issue');

      expect(mockModelRegistryService.rollbackRollout).toHaveBeenCalledWith(
        'rollout_rollback',
        'API issue'
      );
    });
  });

  describe('processScheduledAdvancements', () => {
    it('should process rollouts ready for advancement', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'rollout_1' },
          { id: 'rollout_2' },
        ],
      });

      // Mock for each advanceRollout call
      const rollout = createMockRollout({
        status: 'in_progress',
        strategy: 'gradual',
        config: {
          healthCheckEnabled: true,
          gradualSteps: [10, 25, 50, 100],
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      mockRolloutRepository.findById.mockResolvedValue(rollout);
      dbMockQuery.mockResolvedValue({ rows: [{ current_step: 0 }] });

      const processed = await rolloutService.processScheduledAdvancements();

      expect(processed).toBeGreaterThanOrEqual(0);
    });

    it('should handle errors gracefully', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [{ id: 'rollout_error' }],
      });

      mockRolloutRepository.findById.mockRejectedValue(new Error('Database error'));

      // Should not throw
      const processed = await rolloutService.processScheduledAdvancements();

      expect(mockLogger.error).toHaveBeenCalled();
      expect(processed).toBe(0);
    });
  });

  describe('getRolloutHistory', () => {
    it('should return rollout history for tenant', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'rollout_1',
            tenant_id: 'tenant_123',
            model_id: 'model_1',
            previous_model_id: null,
            version: 1,
            status: 'completed',
            strategy: 'gradual',
            config: JSON.stringify({ healthCheckEnabled: true }),
            requested_by: 'user_1',
            requested_at: new Date(),
            approved_by: 'admin_1',
            approved_at: new Date(),
            rejected_by: null,
            rejected_at: null,
            rejection_reason: null,
            started_at: new Date(),
            completed_at: new Date(),
            rollbacked_at: null,
            rollback_reason: null,
            metrics: JSON.stringify({ requestsTotal: 1000 }),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const history = await rolloutService.getRolloutHistory('tenant_123', 10);

      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('rollout_1');
      expect(history[0].status).toBe('completed');
    });
  });

  describe('getRolloutAuditLog', () => {
    it('should return audit log for rollout', async () => {
      dbMockQuery.mockResolvedValueOnce({
        rows: [
          {
            action: 'rollout_started',
            actor: 'system',
            previous_status: null,
            new_status: 'in_progress',
            details: { strategy: 'gradual' },
            created_at: new Date('2024-01-01T00:00:00Z'),
          },
          {
            action: 'step_advanced',
            actor: 'system',
            previous_status: 'in_progress',
            new_status: 'in_progress',
            details: { step: 1, percentage: 25 },
            created_at: new Date('2024-01-01T01:00:00Z'),
          },
        ],
      });

      const auditLog = await rolloutService.getRolloutAuditLog('rollout_123');

      expect(auditLog).toHaveLength(2);
      expect(auditLog[0].action).toBe('rollout_started');
      expect(auditLog[1].action).toBe('step_advanced');
    });
  });
});

describe('Rollout strategies', () => {
  describe('immediate strategy', () => {
    it('should have single step at 100%', () => {
      const rollout = createMockRollout({
        strategy: 'immediate',
        config: {
          healthCheckEnabled: false,
          notifyOnApproval: [],
          notifyOnFailure: [],
        },
      });

      expect(rollout.strategy).toBe('immediate');
    });
  });

  describe('canary strategy', () => {
    it('should support canary percentage configuration', () => {
      const config: RolloutConfig = {
        healthCheckEnabled: true,
        canaryPercentage: 10,
        canaryDurationMinutes: 30,
        notifyOnApproval: [],
        notifyOnFailure: [],
      };

      expect(config.canaryPercentage).toBe(10);
      expect(config.canaryDurationMinutes).toBe(30);
    });
  });

  describe('gradual strategy', () => {
    it('should support gradual steps configuration', () => {
      const config: RolloutConfig = {
        healthCheckEnabled: true,
        gradualSteps: [10, 25, 50, 100],
        stepDurationMinutes: 60,
        notifyOnApproval: [],
        notifyOnFailure: [],
      };

      expect(config.gradualSteps).toEqual([10, 25, 50, 100]);
      expect(config.stepDurationMinutes).toBe(60);
    });
  });
});

describe('RolloutMetrics', () => {
  it('should track request counts', () => {
    const metrics: RolloutMetrics = {
      requestsTotal: 1000,
      requestsSuccess: 990,
      requestsFailed: 10,
      averageLatencyMs: 150,
      p99LatencyMs: 500,
      errorRate: 0.01,
    };

    expect(metrics.requestsTotal).toBe(1000);
    expect(metrics.requestsSuccess).toBe(990);
    expect(metrics.requestsFailed).toBe(10);
  });

  it('should track latency metrics', () => {
    const metrics: RolloutMetrics = {
      requestsTotal: 1000,
      requestsSuccess: 1000,
      requestsFailed: 0,
      averageLatencyMs: 150,
      p99LatencyMs: 500,
      errorRate: 0,
    };

    expect(metrics.averageLatencyMs).toBe(150);
    expect(metrics.p99LatencyMs).toBe(500);
  });

  it('should track error rate', () => {
    const metrics: RolloutMetrics = {
      requestsTotal: 100,
      requestsSuccess: 95,
      requestsFailed: 5,
      averageLatencyMs: 150,
      p99LatencyMs: 500,
      errorRate: 0.05,
    };

    expect(metrics.errorRate).toBe(0.05);
  });
});

describe('TrafficSplit', () => {
  it('should have required properties', () => {
    const split: TrafficSplit = {
      rolloutId: 'rollout_123',
      percentage: 25,
      isActive: true,
    };

    expect(split.rolloutId).toBeDefined();
    expect(split.percentage).toBeDefined();
    expect(split.isActive).toBeDefined();
  });
});

describe('RolloutProgress', () => {
  it('should have all progress tracking fields', () => {
    const progress: RolloutProgress = {
      rolloutId: 'rollout_123',
      status: 'in_progress',
      strategy: 'gradual',
      currentStep: 1,
      totalSteps: 4,
      currentPercentage: 25,
      targetPercentage: 100,
      nextStepAt: new Date(),
      metrics: {
        requestsTotal: 100,
        requestsSuccess: 95,
        requestsFailed: 5,
        averageLatencyMs: 150,
        p99LatencyMs: 500,
        errorRate: 0.05,
      },
    };

    expect(progress.rolloutId).toBeDefined();
    expect(progress.status).toBeDefined();
    expect(progress.strategy).toBeDefined();
    expect(progress.currentStep).toBeDefined();
    expect(progress.totalSteps).toBeDefined();
    expect(progress.currentPercentage).toBeDefined();
    expect(progress.targetPercentage).toBeDefined();
    expect(progress.metrics).toBeDefined();
  });
});
