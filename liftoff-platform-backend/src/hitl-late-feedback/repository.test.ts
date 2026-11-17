// HITL Late Feedback Repository Tests
// Tests database operations for late feedback storage

import { LateFeedbackRepository } from './repository';
import { CreateLateFeedbackInput, LateFeedbackRow } from './types';

// Mock external dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/logging');

// Get mock pool query function
const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => {
  const mkClient = () => ({ query: (...args: any[]) => mockQuery(...args), release: jest.fn() });
  return {
    pool: { query: (...args: any[]) => mockQuery(...args), connect: () => mkClient() },
    getPool: () => ({ query: (...args: any[]) => mockQuery(...args) }),
    // RLS wrappers route to the same mockQuery so existing assertions hold.
    withTenantScope: (_t: string, fn: (c: any) => any) => fn(mkClient()),
    withAdminScope: (_ctx: any, fn: (c: any) => any) => fn(mkClient()),
  };
});

// Helper to create mock approval snapshot
function createMockApproval(overrides: any = {}) {
  return {
    id: 'approval_123',
    agentId: 'agent_456',
    internalAgentId: 'team_789',
    workflowId: 'workflow_001',
    hitlLevel: 1 as const,
    toolCallsHash: 'hash_abc',
    pendingToolCalls: [{ id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com' } }],
    reason: 'level_1_gate',
    createdAt: '2024-01-01T00:00:00Z',
    expiresAt: '2024-01-01T05:00:00Z',
    ...overrides,
  };
}

// Helper to create mock input
function createMockInput(overrides: Partial<CreateLateFeedbackInput> = {}): CreateLateFeedbackInput {
  return {
    tenantId: '123e4567-e89b-12d3-a456-426614174000',
    approval: createMockApproval(),
    decision: 'would_approve',
    decidedBy: 'user_123',
    decidedByRole: 'admin',
    ...overrides,
  };
}

// Helper to create mock DB row
function createMockRow(overrides: Partial<LateFeedbackRow> = {}): LateFeedbackRow {
  return {
    id: '123e4567-e89b-12d3-a456-426614174001',
    tenant_id: '123e4567-e89b-12d3-a456-426614174000',
    approval_id: 'approval_123',
    agent_id: 'agent_456',
    internal_agent_id: 'team_789',
    workflow_id: 'workflow_001',
    hitl_level: 1,
    tool_calls_hash: 'hash_abc',
    pending_tool_calls: [{ id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com' } }],
    gate_reason: 'level_1_gate',
    decision: 'would_approve',
    decided_by: 'user_123',
    decided_by_role: 'admin',
    rejection_reason: null,
    approval_created_at: new Date('2024-01-01T00:00:00Z'),
    approval_expired_at: new Date('2024-01-01T05:00:00Z'),
    feedback_provided_at: new Date('2024-01-01T06:00:00Z'),
    synced_to_runtime: false,
    sync_attempts: 0,
    last_sync_error: null,
    synced_at: null,
    created_at: new Date('2024-01-01T06:00:00Z'),
    ...overrides,
  };
}

describe('LateFeedbackRepository', () => {
  let repository: LateFeedbackRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new LateFeedbackRepository();
  });

  describe('insert', () => {
    it('inserts late feedback and returns domain model', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const input = createMockInput();
      const result = await repository.insert(input);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(mockRow.id);
      expect(result.tenantId).toBe(mockRow.tenant_id);
      expect(result.approvalId).toBe(mockRow.approval_id);
      expect(result.decision).toBe('would_approve');
      expect(result.hitlLevel).toBe(1);
    });

    it('stores rejection reason when provided', async () => {
      const mockRow = createMockRow({ rejection_reason: 'Unauthorized action', decision: 'would_reject' });
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const input = createMockInput({
        decision: 'would_reject',
        rejectionReason: 'Unauthorized action',
      });
      const result = await repository.insert(input);

      expect(result.rejectionReason).toBe('Unauthorized action');
      expect(result.decision).toBe('would_reject');
    });

    it('handles null internalAgentId and workflowId', async () => {
      const mockRow = createMockRow({ internal_agent_id: null, workflow_id: null });
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const input = createMockInput({
        approval: createMockApproval({ internalAgentId: null, workflowId: null }),
      });
      const result = await repository.insert(input);

      expect(result.internalAgentId).toBeNull();
      expect(result.workflowId).toBeNull();
    });

    it('serializes pendingToolCalls as JSON', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const input = createMockInput();
      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const pendingToolCallsArg = insertCall[1][7]; // 8th parameter
      expect(typeof pendingToolCallsArg).toBe('string');
      expect(JSON.parse(pendingToolCallsArg)).toEqual(input.approval.pendingToolCalls);
    });
  });

  describe('findById', () => {
    it('returns feedback when found', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findById(mockRow.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(mockRow.id);
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findById('non-existent-id');

      expect(result).toBeNull();
    });
  });

  describe('getByApprovalId', () => {
    it('returns feedback for tenant and approval', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.getByApprovalId(mockRow.tenant_id, mockRow.approval_id);

      expect(result).not.toBeNull();
      expect(result?.approvalId).toBe(mockRow.approval_id);
    });

    it('returns null when no feedback exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getByApprovalId('tenant_123', 'approval_456');

      expect(result).toBeNull();
    });

    it('enforces tenant isolation', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.getByApprovalId('tenant_123', 'approval_456');

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('tenant_123');
      expect(queryCall[1]).toContain('approval_456');
    });
  });

  describe('listByAgent', () => {
    it('returns feedback for agent ordered by created_at desc', async () => {
      const rows = [
        createMockRow({ id: 'feedback_1', created_at: new Date('2024-01-02') }),
        createMockRow({ id: 'feedback_2', created_at: new Date('2024-01-01') }),
      ];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await repository.listByAgent('tenant_123', 'agent_456');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('feedback_1');
    });

    it('applies default limit of 100', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.listByAgent('tenant_123', 'agent_456');

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(100);
    });

    it('respects custom limit and offset', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.listByAgent('tenant_123', 'agent_456', { limit: 50, offset: 10 });

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(50);
      expect(queryCall[1]).toContain(10);
    });
  });

  describe('listByToolCallsHash', () => {
    it('returns feedback for matching tool calls hash', async () => {
      const rows = [createMockRow(), createMockRow({ id: 'feedback_2' })];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await repository.listByToolCallsHash('tenant_123', 'hash_abc');

      expect(result).toHaveLength(2);
    });

    it('applies default limit of 50', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.listByToolCallsHash('tenant_123', 'hash_abc');

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(50);
    });
  });

  describe('getUnsynced', () => {
    it('returns unsynced feedback ordered by created_at asc', async () => {
      const rows = [
        createMockRow({ synced_to_runtime: false, sync_attempts: 0 }),
        createMockRow({ id: 'feedback_2', synced_to_runtime: false, sync_attempts: 1 }),
      ];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await repository.getUnsynced();

      expect(result).toHaveLength(2);
    });

    it('excludes items that exceeded max attempts', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.getUnsynced({ maxAttempts: 5 });

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(5);
    });

    it('applies default maxAttempts of 5', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.getUnsynced();

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(5);
    });

    it('applies default limit of 100', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.getUnsynced();

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(100);
    });
  });

  describe('markSynced', () => {
    it('updates synced_to_runtime and synced_at', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await repository.markSynced('feedback_123');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[0]).toContain('synced_to_runtime = TRUE');
      expect(queryCall[0]).toContain('synced_at = NOW()');
      expect(queryCall[1]).toContain('feedback_123');
    });
  });

  describe('recordSyncAttempt', () => {
    it('increments sync_attempts and updates last_sync_error', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await repository.recordSyncAttempt('feedback_123', 'Connection timeout');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[0]).toContain('sync_attempts = sync_attempts + 1');
      expect(queryCall[0]).toContain('last_sync_error');
      expect(queryCall[1]).toContain('feedback_123');
      expect(queryCall[1]).toContain('Connection timeout');
    });
  });

  describe('row to domain model conversion', () => {
    it('converts snake_case to camelCase', async () => {
      const mockRow = createMockRow({
        tenant_id: 'tenant_abc',
        agent_id: 'agent_xyz',
        internal_agent_id: 'team_123',
        hitl_level: 2,
        tool_calls_hash: 'hash_def',
        gate_reason: 'destructive_gate',
        decided_by: 'user_456',
        decided_by_role: 'owner',
        synced_to_runtime: true,
        sync_attempts: 3,
        last_sync_error: 'Network error',
      });
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findById(mockRow.id);

      expect(result?.tenantId).toBe('tenant_abc');
      expect(result?.agentId).toBe('agent_xyz');
      expect(result?.internalAgentId).toBe('team_123');
      expect(result?.hitlLevel).toBe(2);
      expect(result?.toolCallsHash).toBe('hash_def');
      expect(result?.gateReason).toBe('destructive_gate');
      expect(result?.decidedBy).toBe('user_456');
      expect(result?.decidedByRole).toBe('owner');
      expect(result?.syncedToRuntime).toBe(true);
      expect(result?.syncAttempts).toBe(3);
      expect(result?.lastSyncError).toBe('Network error');
    });

    it('preserves date types', async () => {
      const mockRow = createMockRow({
        approval_created_at: new Date('2024-01-01T00:00:00Z'),
        approval_expired_at: new Date('2024-01-01T05:00:00Z'),
        feedback_provided_at: new Date('2024-01-01T06:00:00Z'),
        created_at: new Date('2024-01-01T06:00:00Z'),
      });
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findById(mockRow.id);

      expect(result?.approvalCreatedAt).toBeInstanceOf(Date);
      expect(result?.approvalExpiredAt).toBeInstanceOf(Date);
      expect(result?.feedbackProvidedAt).toBeInstanceOf(Date);
      expect(result?.createdAt).toBeInstanceOf(Date);
    });
  });

  // Backs the "decision window passed" page, which renders many approvals at
  // once and must say which of them were already answered.
  describe('findApprovalIdsWithFeedback', () => {
    const TENANT = '123e4567-e89b-12d3-a456-426614174000';

    it('returns the subset that already carries feedback', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ approval_id: 'apr_1' }] });

      const answered = await repository.findApprovalIdsWithFeedback(TENANT, ['apr_1', 'apr_2']);

      expect(answered.has('apr_1')).toBe(true);
      expect(answered.has('apr_2')).toBe(false);
    });

    it('asks once for the whole page, scoped to the tenant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repository.findApprovalIdsWithFeedback(TENANT, ['apr_1', 'apr_2', 'apr_3']);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('approval_id = ANY($2::uuid[])');
      expect(params).toEqual([TENANT, ['apr_1', 'apr_2', 'apr_3']]);
    });

    it('does not touch the database for an empty page', async () => {
      const answered = await repository.findApprovalIdsWithFeedback(TENANT, []);

      expect(answered.size).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
