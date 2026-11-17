// Correction Protocol Time Window Edge Case Tests
// [TE-004] Test time window edge cases with fake timers

// Mock query function - stable reference
const mockQuery = jest.fn();

// Set global mock reference IMMEDIATELY before jest.mock to avoid hoisting issues
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

import { CorrectionService } from '../service';

// Helper to create mock registry entry
function createMockRegistryEntry(overrides: Partial<any> = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174001',
    tool_name: 'slack_send_message',
    integration_type: 'slack',
    correction_tool_name: 'slack_delete_message',
    correction_type: 'delete',
    time_window_seconds: 3600, // 1 hour window
    requires_previous_state: false,
    user_facing_label: 'Delete message (within 1 hour)',
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
    action: 'slack_send_message',
    inputArgs: { channel: '#general', message: 'Hello' },
    outputSummary: 'Sent message to #general',
    outcome: 'success',
    triggeredBy: 'agent',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('Time Window Edge Cases', () => {
  let service: CorrectionService;
  const { agentAuditLogsService } = require('../../agent-audit-logs/service');
  const tenantId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    service = new CorrectionService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // [TE-004] Allow correction at exact boundary
  it('should allow correction at exact boundary', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: actionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 3600 })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    // Advance to exactly 3599 seconds (just under 1 hour window)
    jest.advanceTimersByTime(3599 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.timeRemaining).toBeGreaterThan(0);
    expect(eligibility.timeRemaining).toBeLessThanOrEqual(1);
  });

  // [TE-004] Reject correction one second after window
  it('should reject correction one second after window', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: actionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 3600 })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    // Advance to exactly 3601 seconds (one second past window)
    jest.advanceTimersByTime(3601 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toContain('Time window for correction has expired');
  });

  // [TE-004] Handle clock skew tolerance
  it('should handle clock skew tolerance', async () => {
    jest.useFakeTimers();

    const now = new Date();
    jest.setSystemTime(now);

    // Set up action with slight clock skew (action recorded 5 seconds in "future")
    const futureActionTime = new Date(now.getTime() + 5000);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: futureActionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 3600 })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    // Should still be eligible despite clock skew
    expect(eligibility.eligible).toBe(true);
  });

  // [TE-004] Zero time window means no time restriction (falsy in JS)
  it('should treat zero time window as no restriction', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: actionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 0 })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    // Advance even 1 second
    jest.advanceTimersByTime(1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    // time_window_seconds=0 is falsy, so no time window check is applied
    expect(eligibility.eligible).toBe(true);
  });

  // [TE-004] Null time window (no limit)
  it('should allow correction with null time window (unlimited)', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: actionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: null })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    // Advance by a very long time (30 days)
    jest.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.timeRemaining).toBeNull();
  });

  // [TE-004] Time remaining calculation
  it('should calculate time remaining correctly', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: actionTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 3600 })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({ rows: [] }); // No config

    // Advance by 30 minutes (1800 seconds)
    jest.advanceTimersByTime(1800 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(true);
    // Should have approximately 1800 seconds remaining (30 minutes)
    expect(eligibility.timeRemaining).toBeGreaterThan(1790);
    expect(eligibility.timeRemaining).toBeLessThanOrEqual(1800);
  });

  // [TE-004] Auto-approve window edge cases
  it('should handle auto-approve window at boundary', async () => {
    jest.useFakeTimers();

    const actionTime = new Date();
    jest.setSystemTime(actionTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({
        createdAt: actionTime,
        triggeredBy: 'human:user-123',
      })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ requires_hitl_approval: true })] })
      .mockResolvedValueOnce({ rows: [] }) // Not corrected
      .mockResolvedValueOnce({ rows: [] }) // No pending
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] }) // Chain depth
      .mockResolvedValueOnce({
        rows: [{
          tenant_id: tenantId,
          require_approval_all: false,
          auto_approve_window: 60, // Auto-approve within 60 seconds
          require_original_actor: false,
        }],
      });

    // At 59 seconds, should still auto-approve
    jest.advanceTimersByTime(59 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.requiresApproval).toBe(false); // Auto-approved
  });

  // [TE-004] Different time zones shouldn't affect window calculation
  it('should use UTC for time window calculation', async () => {
    jest.useFakeTimers();

    // Set system time to a specific UTC time
    const utcTime = new Date('2024-06-15T12:00:00Z');
    jest.setSystemTime(utcTime);

    agentAuditLogsService.getAuditLog.mockResolvedValueOnce(
      createMockAuditLog({ createdAt: utcTime })
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [createMockRegistryEntry({ time_window_seconds: 3600 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ max_depth: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    // Advance 30 minutes
    jest.advanceTimersByTime(1800 * 1000);

    const eligibility = await service.checkCorrectionEligibility(
      tenantId,
      'audit-123'
    );

    expect(eligibility.eligible).toBe(true);
    // Time remaining should be calculated in seconds, not affected by timezone
    expect(eligibility.timeRemaining).toBeGreaterThan(1790);
  });
});
