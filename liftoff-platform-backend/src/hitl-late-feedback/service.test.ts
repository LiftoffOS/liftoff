// HITL Late Feedback Service Tests
// Tests business logic for late feedback submission and syncing

import { LateFeedbackService } from './service';
import { lateFeedbackRepository } from './repository';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { CreateLateFeedbackInput, LateFeedback, ApprovalSnapshot } from './types';

// Mock dependencies
jest.mock('./repository');
jest.mock('../connectors/tenant-runtime-client');
jest.mock('../infrastructure/logging');
jest.mock('../agent-audit-logs/service', () => ({
  agentAuditLogsService: { insertAuditLog: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('./trust-outbox', () => ({
  enqueueLateFeedbackTrustOutbox: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../infrastructure/database', () => ({
  withTenantScope: jest.fn((_tenantId: string, fn: (client: unknown) => unknown) => fn({})),
  getPool: jest.fn(),
  withAdminScope: jest.fn((_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
}));

// Helper to create mock approval snapshot
function createMockApproval(overrides: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
  return {
    id: 'approval_123',
    agentId: 'agent_456',
    internalAgentId: 'team_789',
    workflowId: 'workflow_001',
    hitlLevel: 1,
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

// Helper to create mock feedback
function createMockFeedback(overrides: Partial<LateFeedback> = {}): LateFeedback {
  return {
    id: '123e4567-e89b-12d3-a456-426614174001',
    tenantId: '123e4567-e89b-12d3-a456-426614174000',
    approvalId: 'approval_123',
    agentId: 'agent_456',
    internalAgentId: 'team_789',
    workflowId: 'workflow_001',
    hitlLevel: 1,
    toolCallsHash: 'hash_abc',
    pendingToolCalls: [{ id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com' } }],
    gateReason: 'level_1_gate',
    decision: 'would_approve',
    decidedBy: 'user_123',
    decidedByRole: 'admin',
    rejectionReason: null,
    approvalCreatedAt: new Date('2024-01-01T00:00:00Z'),
    approvalExpiredAt: new Date('2024-01-01T05:00:00Z'),
    feedbackProvidedAt: new Date('2024-01-01T06:00:00Z'),
    syncedToRuntime: false,
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    createdAt: new Date('2024-01-01T06:00:00Z'),
    ...overrides,
  };
}

const mockRepository = lateFeedbackRepository as jest.Mocked<typeof lateFeedbackRepository>;
const mockRuntimeClient = tenantRuntimeClient as jest.Mocked<typeof tenantRuntimeClient>;

describe('LateFeedbackService', () => {
  let service: LateFeedbackService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LateFeedbackService();
  });

  describe('submitLateFeedback', () => {
    it('stores feedback in repository', async () => {
      const feedback = createMockFeedback();
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      const input = createMockInput();
      const result = await service.submitLateFeedback(input);

      // insert now runs inside a shared tenant-scoped transaction (client passed second).
      expect(mockRepository.insert).toHaveBeenCalledWith(input, expect.anything());
      expect(result.id).toBe(feedback.id);
      expect(result.approvalId).toBe(feedback.approvalId);
    });

    it('enqueues a trust-outbox row with deduped action classes and mapped decision', async () => {
      const feedback = createMockFeedback();
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });
      const { enqueueLateFeedbackTrustOutbox } = require('./trust-outbox');

      const input = createMockInput({
        decision: 'would_reject',
        approval: createMockApproval({
          pendingToolCalls: [
            { id: '1', name: 'alias__sendEmail', input: {} },
            { id: '2', name: 'mcp__srv__sendEmail', input: {} }, // same bare action → deduped
            { id: '3', name: 'deleteFile', input: {} },
          ],
          reason: 'sensitive_work',
        }),
      });
      await service.submitLateFeedback(input);

      expect(enqueueLateFeedbackTrustOutbox).toHaveBeenCalledTimes(1);
      const arg = (enqueueLateFeedbackTrustOutbox as jest.Mock).mock.calls[0][1];
      expect(arg.feedbackId).toBe(feedback.id);
      const payload = arg.payload as {
        gateReason: string;
        decisions: Array<{ actionClass: string; decision: string; sourceKey: string }>;
      };
      expect(payload.gateReason).toBe(feedback.gateReason);
      const classes = payload.decisions.map((d) => d.actionClass).sort();
      expect(classes).toEqual(['deleteFile', 'sendEmail']); // mcp/alias prefixes stripped + deduped
      expect(payload.decisions.every((d) => d.decision === 'rejected')).toBe(true);
      const sendEmail = payload.decisions.find((d) => d.actionClass === 'sendEmail');
      expect(sendEmail?.sourceKey).toBe(`${feedback.id}:sendEmail`);
    });

    it('triggers async sync to runtime (fire and forget)', async () => {
      const feedback = createMockFeedback();
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      await service.submitLateFeedback(createMockInput());

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRuntimeClient.sendLateFeedback).toHaveBeenCalledWith(
        feedback.tenantId,
        feedback.id,
        expect.objectContaining({
          approvalId: feedback.approvalId,
          decision: feedback.decision,
          decidedBy: feedback.decidedBy,
          decidedByRole: feedback.decidedByRole,
          toolCallsHash: feedback.toolCallsHash,
          pendingToolCalls: feedback.pendingToolCalls,
        })
      );
    });

    it('does not block on sync failure', async () => {
      const feedback = createMockFeedback();
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.submitLateFeedback(createMockInput());

      // Should return immediately without throwing
      expect(result.id).toBe(feedback.id);
    });

    it('stores rejection reason for would_reject decisions', async () => {
      const feedback = createMockFeedback({
        decision: 'would_reject',
        rejectionReason: 'Unauthorized action',
      });
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      const input = createMockInput({
        decision: 'would_reject',
        rejectionReason: 'Unauthorized action',
      });
      const result = await service.submitLateFeedback(input);

      expect(result.decision).toBe('would_reject');
      expect(result.rejectionReason).toBe('Unauthorized action');
    });
  });

  describe('getByApprovalId', () => {
    it('returns existing feedback for idempotency check', async () => {
      const feedback = createMockFeedback();
      mockRepository.getByApprovalId.mockResolvedValueOnce(feedback);

      const result = await service.getByApprovalId('tenant_123', 'approval_123');

      expect(mockRepository.getByApprovalId).toHaveBeenCalledWith('tenant_123', 'approval_123');
      expect(result?.id).toBe(feedback.id);
    });

    it('returns null when no feedback exists', async () => {
      mockRepository.getByApprovalId.mockResolvedValueOnce(null);

      const result = await service.getByApprovalId('tenant_123', 'approval_456');

      expect(result).toBeNull();
    });
  });

  describe('listByAgent', () => {
    it('returns feedback list for learning queries', async () => {
      const feedbackList = [createMockFeedback(), createMockFeedback({ id: 'feedback_2' })];
      mockRepository.listByAgent.mockResolvedValueOnce(feedbackList);

      const result = await service.listByAgent('tenant_123', 'agent_456');

      expect(mockRepository.listByAgent).toHaveBeenCalledWith('tenant_123', 'agent_456', undefined);
      expect(result).toHaveLength(2);
    });

    it('passes options to repository', async () => {
      mockRepository.listByAgent.mockResolvedValueOnce([]);

      await service.listByAgent('tenant_123', 'agent_456', { limit: 50, offset: 10 });

      expect(mockRepository.listByAgent).toHaveBeenCalledWith('tenant_123', 'agent_456', {
        limit: 50,
        offset: 10,
      });
    });
  });

  describe('listByToolCallsHash', () => {
    it('returns feedback for pattern matching', async () => {
      const feedbackList = [createMockFeedback()];
      mockRepository.listByToolCallsHash.mockResolvedValueOnce(feedbackList);

      const result = await service.listByToolCallsHash('tenant_123', 'hash_abc');

      expect(mockRepository.listByToolCallsHash).toHaveBeenCalledWith(
        'tenant_123',
        'hash_abc',
        undefined
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('syncToRuntime', () => {
    it('delegates to tenant runtime client', async () => {
      const feedback = createMockFeedback();
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      const result = await service.syncToRuntime(feedback);

      expect(mockRuntimeClient.sendLateFeedback).toHaveBeenCalledWith(
        feedback.tenantId,
        feedback.id,
        {
          approvalId: feedback.approvalId,
          decision: feedback.decision,
          decidedBy: feedback.decidedBy,
          decidedByRole: feedback.decidedByRole,
          rejectionReason: undefined,
          toolCallsHash: feedback.toolCallsHash,
          pendingToolCalls: feedback.pendingToolCalls,
        }
      );
      expect(result.success).toBe(true);
    });

    it('handles sync failure', async () => {
      const feedback = createMockFeedback();
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: false });

      const result = await service.syncToRuntime(feedback);

      expect(result.success).toBe(false);
    });

    it('converts null rejectionReason to undefined', async () => {
      const feedback = createMockFeedback({ rejectionReason: null });
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      await service.syncToRuntime(feedback);

      const callArgs = mockRuntimeClient.sendLateFeedback.mock.calls[0][2];
      expect(callArgs.rejectionReason).toBeUndefined();
    });
  });

  describe('getUnsyncedFeedback', () => {
    it('returns unsynced feedback for background job', async () => {
      const feedbackList = [
        createMockFeedback({ syncedToRuntime: false }),
        createMockFeedback({ id: 'feedback_2', syncedToRuntime: false }),
      ];
      mockRepository.getUnsynced.mockResolvedValueOnce(feedbackList);

      const result = await service.getUnsyncedFeedback();

      expect(mockRepository.getUnsynced).toHaveBeenCalledWith(undefined);
      expect(result).toHaveLength(2);
    });

    it('passes options to repository', async () => {
      mockRepository.getUnsynced.mockResolvedValueOnce([]);

      await service.getUnsyncedFeedback({ limit: 50, maxAttempts: 3 });

      expect(mockRepository.getUnsynced).toHaveBeenCalledWith({ limit: 50, maxAttempts: 3 });
    });
  });
});

describe('LateFeedbackService - Integration scenarios', () => {
  let service: LateFeedbackService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LateFeedbackService();
  });

  it('handles HITL level 1 feedback correctly', async () => {
    const feedback = createMockFeedback({ hitlLevel: 1 });
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

    const input = createMockInput({
      approval: createMockApproval({ hitlLevel: 1 }),
    });
    const result = await service.submitLateFeedback(input);

    expect(result.hitlLevel).toBe(1);
  });

  it('handles HITL level 2 feedback correctly', async () => {
    const feedback = createMockFeedback({ hitlLevel: 2 });
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

    const input = createMockInput({
      approval: createMockApproval({ hitlLevel: 2 }),
    });
    const result = await service.submitLateFeedback(input);

    expect(result.hitlLevel).toBe(2);
  });

  it('handles all gate reason types', async () => {
    const gateReasons = [
      'level_1_gate',
      'destructive_gate',
      'super_destructive_gate',
      'sensitive_work',
      'communication_review',
    ] as const;

    for (const reason of gateReasons) {
      jest.clearAllMocks();
      const feedback = createMockFeedback({ gateReason: reason });
      mockRepository.insert.mockResolvedValueOnce(feedback);
      mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

      const input = createMockInput({
        approval: createMockApproval({ reason }),
      });
      const result = await service.submitLateFeedback(input);

      expect(result.gateReason).toBe(reason);
    }
  });

  it('handles multiple tool calls in pending_tool_calls', async () => {
    const pendingToolCalls = [
      { id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com' } },
      { id: 'tc_2', name: 'updateRecord', input: { id: 'rec_123', status: 'active' } },
      { id: 'tc_3', name: 'deleteFile', input: { path: '/tmp/file.txt' } },
    ];
    const feedback = createMockFeedback({ pendingToolCalls });
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });

    const input = createMockInput({
      approval: createMockApproval({ pendingToolCalls }),
    });
    const result = await service.submitLateFeedback(input);

    expect(result.pendingToolCalls).toHaveLength(3);
  });
});

describe('LateFeedbackService - audit log', () => {
  let service: LateFeedbackService;
  const mockInsertAuditLog = agentAuditLogsService.insertAuditLog as jest.MockedFunction<
    typeof agentAuditLogsService.insertAuditLog
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LateFeedbackService();
  });

  it('writes hitl_late_feedback_submitted audit log on success', async () => {
    const feedback = createMockFeedback();
    const input = createMockInput();
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });
    mockInsertAuditLog.mockResolvedValueOnce({} as any);

    await service.submitLateFeedback(input);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hitl_late_feedback_submitted',
        tenantId: input.tenantId,
        triggeredBy: `human:${input.decidedBy}`,
        outcome: 'success',
      })
    );
  });

  it('does not throw if audit log write fails', async () => {
    const feedback = createMockFeedback();
    const input = createMockInput();
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });
    mockInsertAuditLog.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await service.submitLateFeedback(input);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.id).toBe(feedback.id);
  });

  it('omits internalAgentId when feedback.internalAgentId is null', async () => {
    const feedback = createMockFeedback({ internalAgentId: null });
    const input = createMockInput();
    mockRepository.insert.mockResolvedValueOnce(feedback);
    mockRuntimeClient.sendLateFeedback.mockResolvedValueOnce({ success: true });
    mockInsertAuditLog.mockResolvedValueOnce({} as any);

    await service.submitLateFeedback(input);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockInsertAuditLog.mock.calls[0][0].internalAgentId).toBeUndefined();
  });
});
