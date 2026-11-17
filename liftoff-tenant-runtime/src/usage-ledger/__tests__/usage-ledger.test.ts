// Usage Ledger Service Unit Tests
// Tests usage tracking, aggregation, and reporting

import { readFileSync } from 'fs';
import { join } from 'path';
import { UsageLedgerService } from '../service';
import { AggregationService } from '../aggregation-service';
import { pool } from '../../infrastructure/database';
import { UsageEvent, BurnState, RefundInput } from '../types';
import { UsageSnapshot } from '../aggregation-types';

// Mock dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');
jest.mock('../credit-cost-service', () => ({
  creditCostService: {
    getCreditCost: jest.fn().mockResolvedValue(10),
    estimateCredits: jest.fn().mockResolvedValue({
      total: 100,
      breakdown: [
        { action: { actionType: 'create' }, credits: 50 },
        { action: { actionType: 'update' }, credits: 50 },
      ],
    }),
    listCostModels: jest.fn().mockResolvedValue([]),
    upsertCostModel: jest.fn().mockResolvedValue(undefined),
  },
  CreditCostLookup: {},
}));

const mockPool = pool as jest.Mocked<typeof pool>;

// ==========================================
// Mock Factories
// ==========================================

function createMockUsageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-test-123',
    tenantId: 'tenant-test-456',
    agentId: 'agent-test-789',
    workflowId: 'wf-test-123',
    actionId: 'action-test-123',
    eventType: 'salesforce.account.update',
    credits: 10,
    metadata: { connector: 'salesforce' },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createMockBurnState(overrides: Partial<BurnState> = {}): BurnState {
  return {
    tenantId: 'tenant-test-456',
    billingPeriodStart: new Date('2024-01-01T00:00:00Z'),
    billingPeriodEnd: new Date('2024-01-31T23:59:59Z'),
    includedCredits: 10000,
    usedCredits: 2500,
    remainingCredits: 7500,
    overageCredits: 0,
    lastUpdated: new Date('2024-01-15T00:00:00Z'),
    ...overrides,
  };
}

function createMockUsageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    id: 'snapshot-test-123',
    tenantId: 'tenant-test-456',
    period: 'daily',
    periodStart: new Date('2024-01-14T00:00:00Z'),
    periodEnd: new Date('2024-01-15T00:00:00Z'),
    totalCredits: 500,
    totalActions: 50,
    byEventType: { 'salesforce.account.update': 300, 'slack.message.send': 200 },
    byAgent: { 'agent-1': 300, 'agent-2': 200 },
    byConnector: { salesforce: 300, slack: 200 },
    createdAt: new Date('2024-01-15T00:00:00Z'),
    ...overrides,
  };
}

function burnStateToDbRow(burnState: BurnState): Record<string, any> {
  return {
    tenant_id: burnState.tenantId,
    billing_period_start: burnState.billingPeriodStart,
    billing_period_end: burnState.billingPeriodEnd,
    included_credits: burnState.includedCredits,
    used_credits: burnState.usedCredits,
    remaining_credits: burnState.remainingCredits,
    overage_credits: burnState.overageCredits,
    last_updated: burnState.lastUpdated,
  };
}

// ==========================================
// UsageLedgerService Tests
// ==========================================

describe('UsageLedgerService', () => {
  let service: UsageLedgerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsageLedgerService();
  });

  // ==========================================
  // Record Usage Tests
  // ==========================================

  describe('recordUsage', () => {
    it('writes the ledger row and nothing else', async () => {
      const event = createMockUsageEvent();

      (mockPool.query as jest.Mock)
        // Record event
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await expect(service.recordUsage(event)).resolves.not.toThrow();

      // ONE query. Stripe meter calls are gone (usage now flows via
      // Pub/Sub invocation.completed → PB cost-attribution → billing); the
      // burn_state decrement went with the credit admission gate it fed.
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(String((mockPool.query as jest.Mock).mock.calls[0][0])).toContain('INSERT INTO usage_events');
    });

    it('never writes burn_state', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await service.recordUsage(createMockUsageEvent());
      await service.processRefund({
        tenantId: 'tenant-test-456',
        actionId: 'action-test-123',
        credits: 50,
        reason: 'Action compensation',
      });

      const sql = (mockPool.query as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');
      expect(sql).not.toContain('burn_state');
    });

    // Source-level companion: a behavioural test cannot prove a call is absent
    // from every path, so the source is asserted directly.
    it('has no updateBurnState left in usage-ledger/service.ts', () => {
      const source = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
      expect(source).not.toContain('updateBurnState');
    });
  });

  // ==========================================
  // Burn State Tests
  // ==========================================

  describe('getBurnState', () => {
    it('should return burn state for tenant', async () => {
      const mockBurnState = createMockBurnState();

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [burnStateToDbRow(mockBurnState)],
        rowCount: 1,
      } as any);

      const result = await service.getBurnState('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(result.remainingCredits).toBe(7500);
    });
  });

  // getRemainingCredits is gone: it served burn_state.remaining_credits, a
  // never-refilled counter over a mixed-unit column, as if it were a balance.

  // ==========================================
  // Refund Tests
  // ==========================================

  describe('processRefund', () => {
    it('records the refund and touches no counter', async () => {
      const refundInput: RefundInput = {
        tenantId: 'tenant-test-456',
        actionId: 'action-test-123',
        credits: 50,
        reason: 'Action compensation',
      };

      (mockPool.query as jest.Mock)
        // Record refund
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await expect(service.processRefund(refundInput)).resolves.not.toThrow();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(String((mockPool.query as jest.Mock).mock.calls[0][0])).toContain('INSERT INTO refunds');
    });
  });

  // The ledger's own credit-admission helpers (checkAdmission,
  // checkAdmissionWithEstimate) are gone. Both compared burn_state against the
  // legacy entitlement credit columns; neither is authority for anything.
  // Execution permission is admission/service.ts, spend is the control plane.

  // ==========================================
  // Usage with Cost Lookup Tests
  // ==========================================

  describe('recordUsageWithCostLookup', () => {
    it('should record usage with automatic cost lookup', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await service.recordUsageWithCostLookup(
        'tenant-test-456',
        'agent-test-789',
        'wf-test-123',
        'action-test-123',
        'create',
        'salesforce',
        { key: 'value' }
      );

      expect(result.recorded).toBe(true);
      expect(result.credits).toBe(10); // From mock getCreditCost
    });
  });

  describe('estimateCredits', () => {
    it('should estimate credits for planned actions', async () => {
      const actions = [
        { actionType: 'create', connector: 'salesforce' },
        { actionType: 'update', connector: 'salesforce' },
      ];

      const result = await service.estimateCredits('tenant-test-456', actions);

      expect(result.total).toBe(100);
      expect(result.breakdown).toHaveLength(2);
    });
  });

  describe('getCostModels', () => {
    it('should return cost models for tenant', async () => {
      const result = await service.getCostModels('tenant-test-456');

      expect(result).toEqual([]);
    });
  });

  describe('updateCostModel', () => {
    it('should update cost model', async () => {
      await expect(
        service.updateCostModel('tenant-test-456', 'create', 25, 'salesforce')
      ).resolves.not.toThrow();
    });
  });
});

// ==========================================
// AggregationService Tests
// ==========================================

describe('AggregationService', () => {
  let service: AggregationService;
  let mockAggregationRepo: any;
  let mockUsageRepo: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AggregationService();

    // Setup mock aggregation repository
    mockAggregationRepo = {
      createJob: jest.fn().mockResolvedValue({ id: 'job-123' }),
      updateJobStatus: jest.fn().mockResolvedValue(undefined),
      aggregateEvents: jest.fn().mockResolvedValue({
        totalCredits: 500,
        totalActions: 50,
        byEventType: { 'action.create': 300, 'action.update': 200 },
        byAgent: { 'agent-1': 300, 'agent-2': 200 },
        byConnector: { salesforce: 500 },
      }),
      saveSnapshot: jest.fn().mockResolvedValue(createMockUsageSnapshot()),
      saveForecast: jest.fn().mockResolvedValue({
        id: 'forecast-123',
        tenantId: 'tenant-test-456',
        projectedCredits: 10000,
        alerts: [],
      }),
      getSnapshots: jest.fn().mockResolvedValue([
        createMockUsageSnapshot({ totalCredits: 400 }),
        createMockUsageSnapshot({ totalCredits: 500 }),
        createMockUsageSnapshot({ totalCredits: 600 }),
      ]),
      getLatestForecast: jest.fn().mockResolvedValue(null),
      getHourlyUsage: jest.fn().mockResolvedValue([
        { hour: new Date(), credits: 50 },
        { hour: new Date(), credits: 60 },
      ]),
      getActiveTenants: jest.fn().mockResolvedValue(['tenant-1', 'tenant-2']),
    };
    (service as any).aggregationRepo = mockAggregationRepo;

    // Setup mock usage repository
    mockUsageRepo = {
      getBurnState: jest.fn().mockResolvedValue(createMockBurnState()),
    };
    (service as any).usageRepo = mockUsageRepo;
  });

  describe('runAggregation', () => {
    it('should run aggregation and save snapshot', async () => {
      const result = await service.runAggregation(
        'tenant-test-456',
        'daily',
        new Date('2024-01-14T00:00:00Z'),
        new Date('2024-01-15T00:00:00Z')
      );

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(mockAggregationRepo.createJob).toHaveBeenCalled();
      expect(mockAggregationRepo.updateJobStatus).toHaveBeenCalledWith('job-123', 'running');
      expect(mockAggregationRepo.aggregateEvents).toHaveBeenCalled();
      expect(mockAggregationRepo.saveSnapshot).toHaveBeenCalled();
      expect(mockAggregationRepo.updateJobStatus).toHaveBeenCalledWith('job-123', 'completed');
    });

    it('should handle aggregation failure', async () => {
      mockAggregationRepo.aggregateEvents.mockRejectedValueOnce(new Error('Aggregation failed'));

      await expect(
        service.runAggregation(
          'tenant-test-456',
          'daily',
          new Date('2024-01-14T00:00:00Z'),
          new Date('2024-01-15T00:00:00Z')
        )
      ).rejects.toThrow('Aggregation failed');

      expect(mockAggregationRepo.updateJobStatus).toHaveBeenCalledWith(
        'job-123',
        'failed',
        'Aggregation failed'
      );
    });
  });

  describe('runHourlyAggregation', () => {
    it('should run hourly aggregation for current hour', async () => {
      const result = await service.runHourlyAggregation('tenant-test-456');

      expect(result).toBeDefined();
      expect(mockAggregationRepo.createJob).toHaveBeenCalledWith(
        'tenant-test-456',
        'hourly',
        expect.any(Date),
        expect.any(Date)
      );
    });
  });

  describe('runDailyAggregation', () => {
    it('should run daily aggregation for previous day', async () => {
      const result = await service.runDailyAggregation('tenant-test-456');

      expect(result).toBeDefined();
      expect(mockAggregationRepo.createJob).toHaveBeenCalledWith(
        'tenant-test-456',
        'daily',
        expect.any(Date),
        expect.any(Date)
      );
    });
  });

  describe('generateForecast', () => {
    it('should generate forecast with trend analysis', async () => {
      const result = await service.generateForecast('tenant-test-456');

      expect(result).toBeDefined();
      expect(mockUsageRepo.getBurnState).toHaveBeenCalledWith('tenant-test-456');
      expect(mockAggregationRepo.getSnapshots).toHaveBeenCalled();
      expect(mockAggregationRepo.saveForecast).toHaveBeenCalled();
    });

    it('should handle insufficient data for projection', async () => {
      // Return only 2 snapshots (less than 3 required)
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 400 }),
        createMockUsageSnapshot({ totalCredits: 500 }),
      ]);

      const result = await service.generateForecast('tenant-test-456');

      expect(result).toBeDefined();
      // Should save forecast with stable trend due to insufficient data
      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          trend: 'stable',
        })
      );
    });
  });

  describe('getOperatorDashboard', () => {
    it('should return complete operator dashboard', async () => {
      const result = await service.getOperatorDashboard('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(result.currentBurn).toBeDefined();
      expect(result.currentBurn.usedCredits).toBe(2500);
      expect(result.currentBurn.remainingCredits).toBe(7500);
      expect(result.trends).toBeDefined();
      expect(result.topAgents).toBeDefined();
      expect(result.topConnectors).toBeDefined();
    });

    it('should add alert when less than 10% credits remaining', async () => {
      mockUsageRepo.getBurnState.mockResolvedValueOnce(
        createMockBurnState({
          includedCredits: 10000,
          usedCredits: 9500,
          remainingCredits: 500,
        })
      );

      const result = await service.getOperatorDashboard('tenant-test-456');

      expect(result.alerts).toContainEqual(
        expect.objectContaining({
          type: 'approaching_limit',
          severity: 'warning',
        })
      );
    });
  });

  describe('runScheduledAggregation', () => {
    it('should run hourly aggregation for all active tenants', async () => {
      await service.runScheduledAggregation('hourly');

      expect(mockAggregationRepo.getActiveTenants).toHaveBeenCalled();
      // Should have run aggregation for each tenant
      expect(mockAggregationRepo.createJob).toHaveBeenCalledTimes(2);
    });

    it('should run daily aggregation and forecast for all tenants', async () => {
      await service.runScheduledAggregation('daily');

      expect(mockAggregationRepo.getActiveTenants).toHaveBeenCalled();
      // Should have run aggregation for each tenant
      expect(mockAggregationRepo.createJob).toHaveBeenCalledTimes(2);
      // Should have generated forecast for each tenant
      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledTimes(2);
    });

    it('should continue processing other tenants on failure', async () => {
      mockAggregationRepo.aggregateEvents
        .mockRejectedValueOnce(new Error('Tenant 1 failed'))
        .mockResolvedValue({
          totalCredits: 500,
          totalActions: 50,
          byEventType: {},
          byAgent: {},
          byConnector: {},
        });

      // Should not throw
      await expect(service.runScheduledAggregation('hourly')).resolves.not.toThrow();

      // Should have attempted both tenants
      expect(mockAggregationRepo.createJob).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================
  // Trend Calculation Tests
  // ==========================================

  describe('trend calculation (via generateForecast)', () => {
    it('should detect increasing trend', async () => {
      // Create snapshots with increasing credits
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 100 }),
        createMockUsageSnapshot({ totalCredits: 200 }),
        createMockUsageSnapshot({ totalCredits: 300 }),
        createMockUsageSnapshot({ totalCredits: 400 }),
        createMockUsageSnapshot({ totalCredits: 500 }),
      ]);

      await service.generateForecast('tenant-test-456');

      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          trend: 'increasing',
        })
      );
    });

    it('should detect decreasing trend', async () => {
      // Create snapshots with decreasing credits
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 500 }),
        createMockUsageSnapshot({ totalCredits: 400 }),
        createMockUsageSnapshot({ totalCredits: 300 }),
        createMockUsageSnapshot({ totalCredits: 200 }),
        createMockUsageSnapshot({ totalCredits: 100 }),
      ]);

      await service.generateForecast('tenant-test-456');

      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          trend: 'decreasing',
        })
      );
    });

    it('should detect stable trend', async () => {
      // Create snapshots with stable credits
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 500 }),
        createMockUsageSnapshot({ totalCredits: 510 }),
        createMockUsageSnapshot({ totalCredits: 490 }),
        createMockUsageSnapshot({ totalCredits: 505 }),
        createMockUsageSnapshot({ totalCredits: 495 }),
      ]);

      await service.generateForecast('tenant-test-456');

      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          trend: 'stable',
        })
      );
    });
  });

  // ==========================================
  // Alert Generation Tests
  // ==========================================

  describe('alert generation (via generateForecast)', () => {
    it('should generate approaching limit alert', async () => {
      // Set burn state to high usage
      mockUsageRepo.getBurnState.mockResolvedValueOnce(
        createMockBurnState({
          includedCredits: 10000,
          usedCredits: 8500,
          remainingCredits: 1500,
        })
      );

      // Create snapshots that will project high end usage
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 500, totalActions: 50 }),
        createMockUsageSnapshot({ totalCredits: 500, totalActions: 50 }),
        createMockUsageSnapshot({ totalCredits: 500, totalActions: 50 }),
      ]);

      await service.generateForecast('tenant-test-456');

      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          alerts: expect.arrayContaining([
            expect.objectContaining({
              type: 'approaching_limit',
            }),
          ]),
        })
      );
    });

    it('should generate trend change alert for significant changes', async () => {
      // Create snapshots with significant trend
      mockAggregationRepo.getSnapshots.mockResolvedValueOnce([
        createMockUsageSnapshot({ totalCredits: 100 }),
        createMockUsageSnapshot({ totalCredits: 200 }),
        createMockUsageSnapshot({ totalCredits: 400 }),
        createMockUsageSnapshot({ totalCredits: 800 }),
        createMockUsageSnapshot({ totalCredits: 1600 }),
      ]);

      await service.generateForecast('tenant-test-456');

      expect(mockAggregationRepo.saveForecast).toHaveBeenCalledWith(
        expect.objectContaining({
          alerts: expect.arrayContaining([
            expect.objectContaining({
              type: 'trend_change',
            }),
          ]),
        })
      );
    });
  });
});
