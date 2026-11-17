// Correction Protocol Unit Tests
// Phase 6: Tests for eligibility, request flow, rate limiting, budgets, bulk corrections, correction chains

import { CorrectionService } from '../service';
import { CorrectionRepository } from '../repository';

// Mock query function - stable reference
const mockQuery = jest.fn();

// Set global mock reference IMMEDIATELY before jest.mock to avoid hoisting issues
// jest.mock is hoisted to top of file, but modules may load before beforeAll runs
(global as any).__mockQuery = mockQuery;

// Mock external dependencies
jest.mock('../../infrastructure/database', () => {
  const runQuery = (...args: unknown[]) => {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    // RLS: own-tx methods issue SELECT set_config('app.current_tenant_id', ...)
    // right after BEGIN to scope the transaction. Swallow it here so these
    // ordered __mockQuery sequences don't shift (the real ceremony is covered
    // by integration tests).
    if (sql.includes('set_config')) return Promise.resolve({ rows: [] });
    return (global as any).__mockQuery(...args);
  };
  const mkClient = () => ({ query: runQuery, release: jest.fn() });
  return {
    pool: { query: runQuery, connect: () => mkClient() },
    getPool: () => ({ query: runQuery }),
    // RLS wrappers invoke the callback with a mock client so existing
    // __mockQuery assertions still see the real SQL.
    withTenantScope: (_tenantId: string, fn: (c: unknown) => unknown) => fn(mkClient()),
    withAdminScope: (_ctx: unknown, fn: (c: unknown) => unknown) => fn(mkClient()),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../agent-audit-logs/service', () => ({
  agentAuditLogsService: {
    getAuditLog: jest.fn(),
    insertAuditLog: jest.fn().mockResolvedValue({ id: 'audit-123' }),
  },
}));

jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn().mockResolvedValue({ role: 'member' }),
    hasPermission: jest.fn().mockReturnValue(true),
  },
}));

// Helper to create mock registry entry
function createMockRegistryEntry(overrides: Partial<any> = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174001',
    tool_name: 'linear_create_issue',
    integration_type: 'linear',
    correction_tool_name: 'linear_archive_issue',
    correction_type: 'archive',
    time_window_seconds: null,
    requires_previous_state: false,
    user_facing_label: 'Archive issue',
    requires_hitl_approval: false,
    hitl_level: 2,
    max_correction_chain: 3,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// Helper to create mock audit log
function createMockAuditLog(overrides: Partial<any> = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174002',
    tenantId: '123e4567-e89b-12d3-a456-426614174000',
    internalAgentId: 'team-123',
    action: 'linear_create_issue',
    inputArgs: { title: 'Test issue' },
    outputSummary: 'Created issue LIN-123',
    outcome: 'success',
    triggeredBy: 'agent',
    createdAt: new Date(),
    ...overrides,
  };
}

// Helper to create mock config
function createMockConfig(overrides: Partial<any> = {}) {
  return {
    tenant_id: '123e4567-e89b-12d3-a456-426614174000',
    require_approval_all: false,
    auto_approve_window: null,
    require_original_actor: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('CorrectionService', () => {
  let service: CorrectionService;
  const { agentAuditLogsService } = require('../../agent-audit-logs/service');

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    service = new CorrectionService();
  });

  // ==========================================================================
  // Eligibility Check Tests
  // ==========================================================================
  describe('checkCorrectionEligibility', () => {
    it('returns ineligible when audit log not found', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(null);

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Audit log not found');
    });

    it('returns ineligible for non-success outcome', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ outcome: 'error' })
      );

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Only successful actions can be corrected');
    });

    it('returns ineligible when action not in registry', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ action: 'unknown_action' })
      );
      mockQuery.mockResolvedValueOnce({ rows: [] }); // No registry entry

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Action type not registered for correction');
    });

    it('returns ineligible for not_correctable actions', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ action: 'gmail_send_email' })
      );
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRegistryEntry({
          correction_type: 'not_correctable',
          user_facing_label: 'Sent emails cannot be recalled',
        })],
      });

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Sent emails cannot be recalled');
    });

    it('returns ineligible when already corrected', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry()] }) // Registry entry
        .mockResolvedValueOnce({ rows: [{ exists: true }] }); // Already corrected

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Action has already been corrected');
    });

    it('returns ineligible when pending correction exists', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry()] }) // Registry entry
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [{ exists: true }] }); // Pending correction

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('A correction request is already pending');
    });

    it('returns ineligible when max correction chain reached', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ max_correction_chain: 3 })] })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 3 }] }); // Chain depth = 3

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('Maximum correction chain depth');
    });

    it('returns ineligible when time window expired', async () => {
      const oldCreatedAt = new Date(Date.now() - 7200000); // 2 hours ago
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ createdAt: oldCreatedAt })
      );
      mockQuery
        .mockResolvedValueOnce({
          rows: [createMockRegistryEntry({ time_window_seconds: 3600 })], // 1 hour window
        })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
        .mockResolvedValueOnce({ rows: [] }); // No config

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('Time window for correction has expired');
    });

    it('returns eligible with timeRemaining for time-limited actions', async () => {
      const recentCreatedAt = new Date(Date.now() - 1800000); // 30 mins ago
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ createdAt: recentCreatedAt })
      );
      mockQuery
        .mockResolvedValueOnce({
          rows: [createMockRegistryEntry({ time_window_seconds: 3600 })],
        })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
        .mockResolvedValueOnce({ rows: [] }); // No config

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(true);
      expect(result.timeRemaining).toBeGreaterThan(0);
      expect(result.timeRemaining).toBeLessThanOrEqual(1800);
    });

    it('returns eligible without requiresApproval (user click IS the approval)', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({
          rows: [createMockRegistryEntry({ requires_hitl_approval: true })],
        })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
        .mockResolvedValueOnce({ rows: [] }); // No config

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(true);
      // User clicking "Correct" IS the approval - no additional gating
      expect(result.requiresApproval).toBe(false);
    });

    it('auto-approves within auto_approve_window', async () => {
      const recentCreatedAt = new Date(Date.now() - 30000); // 30 seconds ago
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ createdAt: recentCreatedAt })
      );
      mockQuery
        .mockResolvedValueOnce({
          rows: [createMockRegistryEntry({ requires_hitl_approval: true })],
        })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
        .mockResolvedValueOnce({
          rows: [createMockConfig({ auto_approve_window: 60 })], // Auto-approve within 60s
        });

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(true);
      expect(result.requiresApproval).toBe(false); // Auto-approved
    });

    it('returns eligible for valid correctable action', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry()] })
        .mockResolvedValueOnce({ rows: [] }) // Not corrected
        .mockResolvedValueOnce({ rows: [] }) // No pending
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
        .mockResolvedValueOnce({ rows: [] }); // No config

      const result = await service.checkCorrectionEligibility(
        'tenant-123',
        'audit-123'
      );

      expect(result.eligible).toBe(true);
      expect(result.correctionType).toBe('archive');
      expect(result.correctionToolName).toBe('linear_archive_issue');
      expect(result.label).toBe('Archive issue');
    });
  });

  // ==========================================================================
  // Correction Options Tests
  // ==========================================================================
  describe('getCorrectionOptions', () => {
    it('returns user-friendly options for correctable action', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(createMockAuditLog());
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      const options = await service.getCorrectionOptions('tenant-123', 'audit-123');

      expect(options.correctable).toBe(true);
      expect(options.label).toBe('Archive issue');
      expect(options.description).toContain('archived');
    });

    it('returns reason and suggestion for not-correctable action', async () => {
      agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
        createMockAuditLog({ action: 'gmail_send_email' })
      );
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRegistryEntry({
          correction_type: 'not_correctable',
          user_facing_label: 'Sent emails cannot be recalled',
        })],
      });

      const options = await service.getCorrectionOptions('tenant-123', 'audit-123');

      expect(options.correctable).toBe(false);
      expect(options.reason).toBe('Sent emails cannot be recalled');
      expect(options.suggestion).toContain('follow-up email');
    });
  });
});

// ==========================================================================
// Rate Limiting Tests
// ==========================================================================
describe('Rate Limiting', () => {
  const { _checkRateLimit: checkRateLimit, incrementRateUsage: _incrementRateUsage } = require('../rate-limiter');

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('allows request within rate limits', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute usage
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour usage
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day usage

    const result = await checkRateLimit('tenant-123');

    expect(result.allowed).toBe(true);
  });

  it('blocks request when minute limit exceeded', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 10 }] }) // minute at limit
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour usage
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day usage

    const result = await checkRateLimit('tenant-123');

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });

  it('blocks request when hour limit exceeded', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute ok
      .mockResolvedValueOnce({ rows: [{ count: 100 }] }) // hour at limit
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day usage

    const result = await checkRateLimit('tenant-123');

    expect(result.allowed).toBe(false);
  });

  it('blocks request when day limit exceeded', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute ok
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour ok
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }); // day at limit

    const result = await checkRateLimit('tenant-123');

    expect(result.allowed).toBe(false);
  });

  it('uses default limits when tenant has no custom config', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // No custom limits
      .mockResolvedValueOnce({ rows: [] }) // minute usage
      .mockResolvedValueOnce({ rows: [] }) // hour usage
      .mockResolvedValueOnce({ rows: [] }); // day usage

    const result = await checkRateLimit('tenant-123');

    expect(result.allowed).toBe(true);
  });
});

// ==========================================================================
// Budget Tests
// ==========================================================================
describe('Budget Tracking', () => {
  const { checkBudget, checkAndDeductBudget } = require('../budget');

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('allows request when no budget configured (unlimited)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // No budget

    const result = await checkBudget('tenant-123');

    expect(result.allowed).toBe(true);
  });

  it('allows request when budget has remaining', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        budget_limit: 100,
        budget_used: 50,
        budget_period: 'monthly',
        period_start: new Date(),
      }],
    });

    const result = await checkBudget('tenant-123');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(50);
  });

  it('blocks request when budget exhausted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        budget_limit: 100,
        budget_used: 100,
        budget_period: 'monthly',
        period_start: new Date(),
      }],
    });

    const result = await checkBudget('tenant-123');

    expect(result.allowed).toBe(false);
  });

  it('resets budget when period has expired', async () => {
    const oldPeriodStart = new Date();
    oldPeriodStart.setMonth(oldPeriodStart.getMonth() - 2); // 2 months ago

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 100,
          budget_used: 100, // Exhausted
          budget_period: 'monthly',
          period_start: oldPeriodStart,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // Reset query

    const result = await checkAndDeductBudget('tenant-123');

    expect(result.allowed).toBe(true);
  });
});

// ==========================================================================
// Bulk Correction Tests
// ==========================================================================
describe('Bulk Corrections', () => {
  let service: CorrectionService;
  const { agentAuditLogsService } = require('../../agent-audit-logs/service');

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    service = new CorrectionService();
  });

  it('limits bulk requests to 50 items', async () => {
    const auditLogIds = Array(51).fill(null).map((_, i) => `audit-${i}`);

    await expect(
      service.requestBulkCorrection('tenant-123', 'user-123', {
        auditLogIds,
        reason: 'Bulk correction',
      })
    ).rejects.toThrow('Maximum 50 corrections per bulk request');
  });

  it('processes multiple corrections and returns summary', async () => {
    // Setup mocks for rate limit check
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // Rate limits (defaults)
      .mockResolvedValueOnce({ rows: [] }) // minute usage
      .mockResolvedValueOnce({ rows: [] }) // hour usage
      .mockResolvedValueOnce({ rows: [] }); // day usage

    // Setup mocks for first correction
    agentAuditLogsService.getAuditLog
      .mockResolvedValueOnce(createMockAuditLog({ id: 'audit-1' }))
      .mockResolvedValueOnce(createMockAuditLog({ id: 'audit-2' }));

    // Mock eligibility checks (multiple queries per correction)
    for (let i = 0; i < 2; i++) {
      mockQuery
        .mockResolvedValueOnce({ rows: [createMockRegistryEntry()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] })
        .mockResolvedValueOnce({ rows: [] }) // config
        .mockResolvedValueOnce({ rows: [] }) // budget check
        .mockResolvedValueOnce({ rows: [] }); // budget deduct
    }

    // Mock rate increment
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await service.requestBulkCorrection('tenant-123', 'user-123', {
      auditLogIds: ['audit-1', 'audit-2'],
      reason: 'Bulk test',
    });

    expect(result.summary.total).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it('continues processing on error when stopOnError is false', async () => {
    // Setup rate limit atomic check mock - returns allowed with usage
    mockQuery
      // Rate limits query
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 100, max_per_hour: 1000, max_per_day: 5000 }] })
      // BEGIN
      .mockResolvedValueOnce({ rows: [] })
      // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for minute
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for hour
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for day
      .mockResolvedValueOnce({ rows: [] })
      // COMMIT
      .mockResolvedValueOnce({ rows: [] });

    // First audit log not found (returns error - not ineligible in service logic)
    // Second audit log also not found (returns error)
    // Both should be processed, not stopped at first
    agentAuditLogsService.getAuditLog
      .mockResolvedValueOnce(null) // First audit log - not found
      .mockResolvedValueOnce(null); // Second audit log - not found

    const result = await service.requestBulkCorrection('tenant-123', 'user-123', {
      auditLogIds: ['audit-1', 'audit-2'],
      reason: 'Test',
      stopOnError: false,
    });

    // Both should be marked as error (not found returns status 'error')
    expect(result.summary.total).toBe(2);
    expect(result.summary.errors).toBe(2);
    // Verify both were processed (stopOnError=false means continue)
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('error');
    expect(result.results[1].status).toBe('error');
  });

  it('stops processing on first error when stopOnError is true', async () => {
    // Setup rate limit atomic check mock - returns allowed
    mockQuery
      // Rate limits query
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 100, max_per_hour: 1000, max_per_day: 5000 }] })
      // BEGIN
      .mockResolvedValueOnce({ rows: [] })
      // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for minute
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for hour
      .mockResolvedValueOnce({ rows: [] })
      // INSERT/UPDATE for day
      .mockResolvedValueOnce({ rows: [] })
      // COMMIT
      .mockResolvedValueOnce({ rows: [] });

    // First audit log not found
    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(null);

    const result = await service.requestBulkCorrection('tenant-123', 'user-123', {
      auditLogIds: ['audit-1', 'audit-2'],
      reason: 'Test',
      stopOnError: true,
    });

    expect(result.summary.total).toBe(2);
    expect(result.summary.errors).toBe(1);
    expect(result.summary.requested).toBe(0);
    // Should not process second item
    expect(agentAuditLogsService.getAuditLog).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Correction Chain Tests
// ==========================================================================
describe('Correction Chains', () => {
  let repository: CorrectionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    repository = new CorrectionRepository();
  });

  it('calculates chain depth correctly with recursive CTE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_depth: 2 }] });

    const depth = await repository.getCorrectionChainDepth('tenant-123', 'audit-123');

    expect(depth).toBe(2);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WITH RECURSIVE'),
      expect.any(Array)
    );
  });

  it('returns 1 for actions with no corrections', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_depth: 1 }] });

    const depth = await repository.getCorrectionChainDepth('tenant-123', 'audit-123');

    expect(depth).toBe(1);
  });

  it('returns 1 when no depth found (null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_depth: null }] });

    const depth = await repository.getCorrectionChainDepth('tenant-123', 'audit-123');

    expect(depth).toBe(1);
  });
});

// ==========================================================================
// Correction History Tests
// ==========================================================================
describe('Correction History', () => {
  let repository: CorrectionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    repository = new CorrectionRepository();
  });

  it('returns full audit trail with original and corrections', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'original-123',
          action: 'linear_create_issue',
          correction_of: null,
          outcome: 'success',
          triggered_by: 'agent',
          created_at: new Date('2024-01-01T10:00:00Z'),
          input_args: { title: 'Bug fix' },
          output_summary: 'Created LIN-123',
        },
        {
          id: 'correction-456',
          action: 'linear_archive_issue',
          correction_of: 'original-123',
          outcome: 'success',
          triggered_by: 'human:user-123',
          created_at: new Date('2024-01-01T10:05:00Z'),
          input_args: { issueId: 'LIN-123' },
          output_summary: 'Archived LIN-123',
        },
      ],
    });

    const history = await repository.getCorrectionHistory('tenant-123', 'original-123');

    expect(history).toHaveLength(2);
    expect(history[0].action).toBe('linear_create_issue');
    expect(history[0].correctionOf).toBeNull();
    expect(history[1].action).toBe('linear_archive_issue');
    expect(history[1].correctionOf).toBe('original-123');
  });
});


// ==========================================================================
// TE-001: IDOR Protection Tests
// ==========================================================================
describe('IDOR Protection (TE-001)', () => {
  it('requires tenant membership verification for correction-options endpoint', async () => {
    // This test verifies that the router has tenant membership checks
    // The actual implementation check is done in router.ts
    const routerCode = require('fs').readFileSync(
      require('path').join(__dirname, '../router.ts'),
      'utf-8'
    );

    expect(routerCode).toContain('tenantMembersService.getMembership');
    expect(routerCode).toContain("'Not authorized for this tenant'");
  });
});

// ==========================================================================
// TE-002 & TE-003: Race Condition Tests
// ==========================================================================
describe('Atomic Rate Limit Operations (TE-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('checkAndIncrementRateUsage uses SELECT FOR UPDATE', async () => {
    const { CorrectionRepository } = require('../repository');
    const repo = new CorrectionRepository();

    // Mock rate limits
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      // Mock BEGIN
      .mockResolvedValueOnce({ rows: [] })
      // Mock SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })
      // Mock INSERT/UPDATE for minute
      .mockResolvedValueOnce({ rows: [] })
      // Mock INSERT/UPDATE for hour
      .mockResolvedValueOnce({ rows: [] })
      // Mock INSERT/UPDATE for day
      .mockResolvedValueOnce({ rows: [] })
      // Mock COMMIT
      .mockResolvedValueOnce({ rows: [] });

    await repo.checkAndIncrementRateUsage('tenant-123');

    // Verify FOR UPDATE is used for locking
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      expect.any(Array)
    );
  });
});

describe('Atomic Budget Operations (TE-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('checkAndDeductBudget uses transaction with FOR UPDATE', async () => {
    const { CorrectionRepository } = require('../repository');
    const repo = new CorrectionRepository();

    // Mock BEGIN, SELECT FOR UPDATE, UPDATE, COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ budget_limit: 100, budget_used: 50, budget_period: 'monthly', period_start: new Date() }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await repo.checkAndDeductBudget('tenant-123');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      expect.any(Array)
    );
  });
});

// ==========================================================================
// TE-005: Recursive CTE Depth Limit Tests
// ==========================================================================
describe('Recursive CTE Depth Limit (TE-005)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('getCorrectionChainDepth includes depth limit in query', async () => {
    const { CorrectionRepository } = require('../repository');
    const repo = new CorrectionRepository();

    mockQuery.mockResolvedValueOnce({ rows: [{ max_depth: 5 }] });

    await repo.getCorrectionChainDepth('tenant-123', 'audit-123');

    // Verify query includes depth limit
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('c.depth <'),
      expect.arrayContaining(['audit-123', 'tenant-123', expect.any(Number)])
    );
  });
});


// ==========================================================================
// TE-012: Service Token Timing Safety Tests
// ==========================================================================
describe('Service Token Timing Safety (TE-012)', () => {
  it('serviceAuthMiddleware uses timingSafeEqual for token comparison', async () => {
    const routerCode = require('fs').readFileSync(
      require('path').join(__dirname, '../router.ts'),
      'utf-8'
    );

    expect(routerCode).toContain('crypto.timingSafeEqual');
    expect(routerCode).toContain("Buffer.from(serviceToken)");
    expect(routerCode).toContain("Buffer.from(expectedToken)");
  });
});

// ==========================================================================
// Financial Corrections Tests
// ==========================================================================
describe('Financial Corrections', () => {
  let repository: CorrectionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    repository = new CorrectionRepository();
  });

  it('inserts financial correction record', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'fin-123',
        tenant_id: 'tenant-123',
        original_audit_log_id: 'audit-1',
        correction_audit_log_id: 'audit-2',
        correction_type: 'refund',
        amount_cents: 5000,
        currency: 'usd',
        reason: 'Customer requested refund',
        reconciled: false,
        reconciled_at: null,
        reconciled_by: null,
        created_at: new Date(),
      }],
    });

    const result = await repository.insertFinancialCorrection({
      tenantId: 'tenant-123',
      originalAuditLogId: 'audit-1',
      correctionAuditLogId: 'audit-2',
      correctionType: 'refund',
      amountCents: 5000,
      currency: 'usd',
      reason: 'Customer requested refund',
    });

    expect(result.id).toBe('fin-123');
    expect(result.amountCents).toBe(5000);
    expect(result.reconciled).toBe(false);
  });

});
