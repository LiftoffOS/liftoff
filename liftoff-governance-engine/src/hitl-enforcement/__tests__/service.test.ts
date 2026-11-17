// HITL Enforcement Service Tests
// Per implementation plan: [TE-001] Phase 1.8

import {
  ToolCallRequest,
  ModelTool,
  OversightSettings,
  SUPER_DESTRUCTIVE_OPERATIONS,
  HitlGateError,
} from '../types';
import { HitlEnforcementService } from '../service';

// Mock database pool
jest.mock('../../infrastructure/database', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
  },
}));

// Mock audit logging
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// Mock events publisher — rejectRequest + recordLateFeedback publish
// governance events; keep it inert so tests don't try to talk to Pub/Sub.
jest.mock('../../events/publisher', () => ({
  publishCorrectionCaptured: jest.fn().mockResolvedValue(undefined),
  publishLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined),
  publishActionCompensated: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {
    onLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined),
    onActionCompensated: jest.fn().mockResolvedValue(undefined),
  },
}));

import { pool } from '../../infrastructure/database';
import { insertAuditLog } from '../../audit/service';

const mockPool = pool as jest.Mocked<typeof pool>;
const mockInsertAuditLog = insertAuditLog as jest.MockedFunction<typeof insertAuditLog>;

describe('HitlEnforcementService', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    // Reset rate limit mock to return 0 operations by default
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  describe('checkHitlGate', () => {
    const mockTools: ModelTool[] = [
      { name: 'gmail_send_email', description: 'Send an email', categories: ['customerCommunication'] },
      { name: 'gmail_search', description: 'Search emails', categories: [] },
      { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Permanently deletes a record' },
      { name: 'update_record', description: 'Updates a record' },
      { name: 'stripe_refund', description: 'Process refund', categories: ['financialActions'] },
    ];

    const mockOversight: OversightSettings = {
      tenantId: 'tenant-123',
      autonomy: 'balanced',
      escalation: 'sensitive',
      sensitiveWork: {
        customerCommunication: true,
        financialActions: true,
        dataChanges: false,
        externalPublishing: true,
        hiringDecisions: false,
      },
      communication: 'review',
    };

    it('should throw level_1_gate for any tool call at hitl_level 1', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_search', input: { query: 'test' } },
      ];

      const result = await service.checkHitlGate(toolCalls, mockOversight, 1, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('level_1_gate');
    });

    it('should allow non-destructive tools at hitl_level 2', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_search', input: { query: 'test' } },
        { id: 'tc2', name: 'update_record', input: { id: '123' } },
      ];

      // Use oversight with escalation='exceptions' to skip sensitive work check
      const oversight = { ...mockOversight, escalation: 'exceptions' as const };
      const result = await service.checkHitlGate(toolCalls, oversight, 2, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('should throw destructive_gate for destructive tools at hitl_level 2', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'delete_record', input: { id: '123' } },
      ];

      const result = await service.checkHitlGate(toolCalls, mockOversight, 2, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('destructive_gate');
    });

    it('should allow all tools at hitl_level 3+', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'delete_record', input: { id: '123' } },
        { id: 'tc2', name: 'gmail_send_email', input: { to: 'test@example.com' } },
      ];

      // Use escalation='exceptions' to skip sensitive work check
      const oversight = { ...mockOversight, escalation: 'exceptions' as const };
      const result = await service.checkHitlGate(toolCalls, oversight, 3, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, expect.any(String),
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('should ALWAYS throw super_destructive_gate regardless of hitl_level', async () => {
      // Test all super destructive operations
      for (const opName of SUPER_DESTRUCTIVE_OPERATIONS) {
        const toolCalls: ToolCallRequest[] = [
          { id: 'tc1', name: opName, input: {} },
        ];

        // Even at level 5 (most autonomous)
        const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

        expect(result.shouldGate).toBe(true);
        expect(result.reason).toBe('super_destructive_gate');
      }
    });

    it('fires super_destructive_gate for prefixed (connector/mcp-namespaced) names', async () => {
      // Runtime tool names always carry a dispatch prefix — never bare.
      for (const opName of SUPER_DESTRUCTIVE_OPERATIONS) {
        for (const prefixed of [`admin__${opName}`, `mcp__liftoff-tools-t1__admin__${opName}`]) {
          const result = await service.checkHitlGate(
            [{ id: 'tc1', name: prefixed, input: {} }],
            mockOversight, 5, mockTools, 'tenant-123',
          );
          expect(result.shouldGate).toBe(true);
          expect(result.reason).toBe('super_destructive_gate');
        }
      }
    });

    it.each([
      'merge_pull_request',
      'github-ab12__merge_pull_request',
      'mcp__github-ab12__merge_pull_request',
      'mcp__liftoff-tools-t1__github-ab12__squash_and_merge_pull_request',
    ])('fires merge_to_main gate for "%s" when mergeToMain is enabled', async (toolName) => {
      const mergeOversight: OversightSettings = {
        ...mockOversight,
        sensitiveWork: { ...mockOversight.sensitiveWork, mergeToMain: true },
      };
      const result = await service.checkHitlGate(
        [{ id: 'tc1', name: toolName, input: { pr: 1 } }],
        mergeOversight, 5, mockTools, 'tenant-123', 'agent-abc',
      );
      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('merge_to_main');
    });

    it('should return no gate for empty tool calls array', async () => {
      const toolCalls: ToolCallRequest[] = [];

      // Empty array should return immediately without gating, regardless of level
      const result = await service.checkHitlGate(toolCalls, mockOversight, 1, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(false);
      expect(result.reason).toBeUndefined();
      // Should not trigger any audit logging
      expect(mockInsertAuditLog).not.toHaveBeenCalled();
    });

    it('should handle tools without descriptions', async () => {
      const toolsWithoutDesc: ModelTool[] = [
        { name: 'custom_tool' }, // No description
      ];
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'custom_tool', input: {} },
      ];

      // At level 2, should check for DESTRUCTIVE marker but tool has no description
      const oversight = { ...mockOversight, escalation: 'exceptions' as const };
      const result = await service.checkHitlGate(toolCalls, oversight, 2, toolsWithoutDesc, 'tenant-123');

      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('should be case-sensitive for DESTRUCTIVE marker', async () => {
      const toolsLowercase: ModelTool[] = [
        { name: 'soft_delete', description: 'destructive operation (lowercase)' }, // lowercase
      ];
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'soft_delete', input: {} },
      ];

      const oversight = { ...mockOversight, escalation: 'exceptions' as const };
      const result = await service.checkHitlGate(toolCalls, oversight, 2, toolsLowercase, 'tenant-123');

      // Should NOT gate because marker must be '⚠️ DESTRUCTIVE' (exact match)
      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('should gate sensitive work when escalation is sensitive', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send_email', input: { to: 'customer@example.com' } },
      ];

      const result = await service.checkHitlGate(toolCalls, mockOversight, 3, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('sensitive_work');
      expect(result.matchedCategory).toBe('customerCommunication');
    });

    it('should NOT gate sensitive work when escalation is exceptions', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send_email', input: { to: 'customer@example.com' } },
      ];

      const oversight = { ...mockOversight, escalation: 'exceptions' as const };
      const result = await service.checkHitlGate(toolCalls, oversight, 3, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
        expect.objectContaining({ outcome: 'success' })
      );
    });

    it('should gate financial actions when enabled', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'stripe_refund', input: { amount: 100 } },
      ];

      const result = await service.checkHitlGate(toolCalls, mockOversight, 3, mockTools, 'tenant-123');

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('sensitive_work');
      expect(result.matchedCategory).toBe('financialActions');
    });

    it('should handle undefined oversight settings', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send_email', input: {} },
      ];

      const result = await service.checkHitlGate(toolCalls, undefined, 3, mockTools, 'tenant-123');

      // Without oversight, only level and super-destructive checks apply
      expect(result.shouldGate).toBe(false);
      expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
        expect.objectContaining({ outcome: 'success' })
      );
    });
  });

  describe('hashToolCalls', () => {
    it('should produce consistent hash for same tool calls', () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send', input: { to: 'test@example.com' } },
      ];

      const hash1 = service.hashToolCalls(toolCalls);
      const hash2 = service.hashToolCalls(toolCalls);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different tool calls', () => {
      const toolCalls1: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send', input: { to: 'test@example.com' } },
      ];
      const toolCalls2: ToolCallRequest[] = [
        { id: 'tc1', name: 'gmail_send', input: { to: 'other@example.com' } },
      ];

      const hash1 = service.hashToolCalls(toolCalls1);
      const hash2 = service.hashToolCalls(toolCalls2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex string (SHA256)', () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'test', input: {} },
      ];

      const hash = service.hashToolCalls(toolCalls);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getDefaultHitlLevel', () => {
    it('should return 2 for controlled autonomy', () => {
      expect(service.getDefaultHitlLevel('controlled')).toBe(2);
    });

    it('should return 3 for balanced autonomy', () => {
      expect(service.getDefaultHitlLevel('balanced')).toBe(3);
    });

    it('should return 4 for autonomous', () => {
      expect(service.getDefaultHitlLevel('autonomous')).toBe(4);
    });

    it('should return 3 for unknown autonomy level', () => {
      expect(service.getDefaultHitlLevel('unknown')).toBe(3);
    });
  });

  describe('recordLateFeedback', () => {
    const TENANT_ID = '00000000-0000-0000-0000-000000000001';
    const OTHER_TENANT_ID = '00000000-0000-0000-0000-000000000002';
    const APPROVAL_ID = '00000000-0000-0000-0000-000000000010';
    const AGENT_ID = '00000000-0000-0000-0000-000000000020';
    const TASK_ID = '00000000-0000-0000-0000-000000000030';
    const FEEDBACK_ID = '00000000-0000-0000-0000-000000000040';

    it('inserts a fresh row and returns inserted=true with the agent_id', async () => {
      (mockPool.query as jest.Mock)
        // First query: lookup approval
        .mockResolvedValueOnce({
          rows: [{ agent_id: AGENT_ID, tenant_id: TENANT_ID, task_id: TASK_ID }],
        })
        // Second query: insert returning id
        .mockResolvedValueOnce({ rows: [{ id: 'fb_001' }] });

      const result = await service.recordLateFeedback({
        feedbackId: FEEDBACK_ID,
        tenantId: TENANT_ID,
        approvalId: APPROVAL_ID,
        decision: 'rejected',
        decidedBy: 'user-abc',
        decidedByRole: 'admin',
        rejectionReason: 'Wrong recipient',
      });

      expect(result).toEqual({ inserted: true, agentId: AGENT_ID });

      // Verify the insert SQL was called with the correct columns and ON CONFLICT.
      const insertCall = (mockPool.query as jest.Mock).mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO human_feedback');
      expect(insertCall[0]).toContain('ON CONFLICT (feedback_id)');
      expect(insertCall[1]).toEqual([
        AGENT_ID,
        TENANT_ID,
        TASK_ID,
        'Late rejection by admin (user-abc): Wrong recipient',
        'late_rejection',
        FEEDBACK_ID,
      ]);
    });

    it('encodes late_approval feedback type for approved decisions', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ agent_id: AGENT_ID, tenant_id: TENANT_ID, task_id: TASK_ID }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'fb_002' }] });

      await service.recordLateFeedback({
        feedbackId: FEEDBACK_ID,
        tenantId: TENANT_ID,
        approvalId: APPROVAL_ID,
        decision: 'approved',
        decidedBy: 'user-abc',
        decidedByRole: 'member',
      });

      const insertCall = (mockPool.query as jest.Mock).mock.calls[1];
      expect(insertCall[1][3]).toBe('Late approved by member (user-abc)');
      expect(insertCall[1][4]).toBe('late_approval');
    });

    it('returns inserted=false when ON CONFLICT swallows a duplicate', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ agent_id: AGENT_ID, tenant_id: TENANT_ID, task_id: TASK_ID }],
        })
        // Duplicate: ON CONFLICT DO NOTHING returns zero rows.
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.recordLateFeedback({
        feedbackId: FEEDBACK_ID,
        tenantId: TENANT_ID,
        approvalId: APPROVAL_ID,
        decision: 'approved',
        decidedBy: 'user-abc',
        decidedByRole: 'member',
      });

      expect(result).toEqual({ inserted: false, agentId: AGENT_ID });
    });

    it('returns agentId=null when the approval does not exist', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await service.recordLateFeedback({
        feedbackId: FEEDBACK_ID,
        tenantId: TENANT_ID,
        approvalId: APPROVAL_ID,
        decision: 'approved',
        decidedBy: 'user-abc',
        decidedByRole: 'member',
      });

      expect(result).toEqual({ inserted: false, agentId: null });
      // No insert should have been attempted.
      expect((mockPool.query as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('rejects cross-tenant attempts and never inserts', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ agent_id: AGENT_ID, tenant_id: OTHER_TENANT_ID, task_id: TASK_ID }],
      });

      const result = await service.recordLateFeedback({
        feedbackId: FEEDBACK_ID,
        tenantId: TENANT_ID,
        approvalId: APPROVAL_ID,
        decision: 'approved',
        decidedBy: 'user-abc',
        decidedByRole: 'member',
      });

      expect(result).toEqual({ inserted: false, agentId: null });
      expect((mockPool.query as jest.Mock).mock.calls).toHaveLength(1);
    });
  });
});

describe('HitlGateError', () => {
  it('should contain pending tool calls and reason', () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'delete_all', input: {} },
    ];

    const error = new HitlGateError(toolCalls, 'super_destructive_gate');

    expect(error.pendingToolCalls).toEqual(toolCalls);
    expect(error.reason).toBe('super_destructive_gate');
    expect(error.message).toBe('HITL gate: human approval required');
    expect(error.name).toBe('HitlGateError');
  });

  it('should include matched category for sensitive_work', () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_send', input: {} },
    ];

    const error = new HitlGateError(toolCalls, 'sensitive_work', 'customerCommunication');

    expect(error.matchedCategory).toBe('customerCommunication');
  });
});

describe('SUPER_DESTRUCTIVE_OPERATIONS', () => {
  it('should contain all required operations', () => {
    const required = [
      'delete_tenant',
      'bulk_delete_users',
      'export_all_data',
      'modify_billing',
      'delete_all_memories',
      'revoke_all_api_keys',
    ];

    for (const op of required) {
      expect(SUPER_DESTRUCTIVE_OPERATIONS.has(op)).toBe(true);
    }
  });
});

// [TE-001, TE-005] Comprehensive Level 5 test suite
describe('HITL Level 5 - Fully Autonomous', () => {
  let service: HitlEnforcementService;

  const mockTools: ModelTool[] = [
    { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Permanently deletes a record', categories: ['dataChanges'] },
    { name: 'send_email', description: 'Send an email to a customer', categories: ['customerCommunication'] },
    { name: 'create_charge', description: 'Create a payment charge', categories: ['financialActions'] },
    { name: 'publish_post', description: 'Publish a blog post', categories: ['externalPublishing'] },
  ];

  const mockOversight: OversightSettings = {
    tenantId: 'tenant-123',
    autonomy: 'balanced',
    escalation: 'sensitive',
    sensitiveWork: {
      customerCommunication: true,
      financialActions: true,
      dataChanges: true,
      externalPublishing: true,
      hiringDecisions: true,
    },
    communication: 'review',
  };

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    // Reset rate limit mock to return 0 operations by default
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  // TE-001: Basic Level 5 tests
  it('Level 5 allows destructive tools without gating', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'delete_record', input: { id: '123' } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
  });

  it('Level 5 allows communication tools without gating', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'send_email', input: { to: 'test@example.com' } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
  });

  it('Level 5 allows financial tools without gating', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'create_charge', input: { amount: 100 } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
  });

  it('Level 5 still gates super-destructive operations', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'delete_tenant', input: {} },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('super_destructive_gate');
  });

  it('No autonomy setting maps to level 5', () => {
    const autonomySettings = ['controlled', 'balanced', 'autonomous'];
    for (const setting of autonomySettings) {
      const level = service.getDefaultHitlLevel(setting);
      expect(level).toBeLessThan(5);
    }
  });

  // TE-005: Boundary test - Level 5 with sensitive work enabled
  it('Level 5 bypasses sensitive work check even with escalation=sensitive', async () => {
    const sensitiveOversight: OversightSettings = {
      ...mockOversight,
      escalation: 'sensitive',
      sensitiveWork: {
        customerCommunication: true,
        financialActions: true,
        dataChanges: true,
        externalPublishing: true,
        hiringDecisions: true,
      },
    };

    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'send_email', input: { to: 'test@example.com' } },
    ];

    const result = await service.checkHitlGate(toolCalls, sensitiveOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
  });

  // SE-001: Rate limiting test
  it('Level 5 gates when rate limit exceeded', async () => {
    // Mock getRecentOperationCount to return > LEVEL_5_HOURLY_LIMIT (1000)
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1001' }] });

    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'send_email', input: { to: 'test@example.com' } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('rate_limit_exceeded');
    expect(result.message).toContain('1001');
    expect(result.message).toContain('1000');
  });

  // SE-002: Audit logging test (updated to check actual tool name, not generic string)
  it('Level 5 writes per-tool audit records with actual tool name (not generic string)', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'send_email', input: { to: 'test@example.com' } },
      { id: 'tc2', name: 'create_charge', input: { amount: 100 } },
    ];

    await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      null, 'tenant-123',
      expect.objectContaining({
        action: 'send_email',
        inputArgs: expect.objectContaining({ hitlLevel: 5, autoElevated: false }),
        outcome: 'success',
      })
    );
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      null, 'tenant-123',
      expect.objectContaining({ action: 'create_charge' })
    );

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual(['tenant-123', 5, 'send_email', false]);
  });
});

// Level 4 Smart Autonomous - Per-tool risk-based auto-elevation
describe('HITL Level 4 - Smart Autonomous (Auto-Elevation)', () => {
  let service: HitlEnforcementService;

  // Tools with explicit classifications
  const mockTools: ModelTool[] = [
    // Low-risk: explicitly classified with empty categories
    { name: 'gmail_search', description: 'Search emails', categories: [] },
    { name: 'gmail_read', description: 'Read an email', categories: [] },
    { name: 'stripe_get_balance', description: 'Get account balance', categories: [] },
    // Higher-risk: has sensitive categories
    { name: 'gmail_send', description: 'Send an email', categories: ['customerCommunication'] },
    { name: 'stripe_refund', description: 'Process refund', categories: ['financialActions'] },
    // Destructive: has marker
    { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Delete a record', categories: [] },
    // Unclassified: categories undefined
    { name: 'custom_tool', description: 'A custom MCP tool' },
  ];

  const mockOversight: OversightSettings = {
    tenantId: 'tenant-123',
    autonomy: 'autonomous',
    escalation: 'sensitive',
    sensitiveWork: {
      customerCommunication: true,
      financialActions: true,
      dataChanges: false,
      externalPublishing: true,
      hiringDecisions: false,
    },
    communication: 'review',
  };

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('Level 4 auto-elevates low-risk tools (empty categories) to Level 5 behavior', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_search', input: { query: 'test' } },
      { id: 'tc2', name: 'gmail_read', input: { id: '123' } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
    // Should log as auto-elevated
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      null,
      'tenant-123',
      expect.objectContaining({
        action: 'gmail_search',
        inputArgs: expect.objectContaining({
          hitlLevel: 4,
          autoElevated: true,
        }),
        outcome: 'success',
      })
    );

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls[0][1]).toEqual(['tenant-123', 4, 'gmail_search', true]);
  });

  it('Level 4 does NOT auto-elevate tools with sensitive categories', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_send', input: { to: 'test@example.com' } },
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');

    // Should fall through to sensitive work check and gate
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('sensitive_work');
    expect(result.matchedCategory).toBe('customerCommunication');
    // Should log gated audit record (not auto-elevated)
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'gmail_send',
        inputArgs: expect.objectContaining({
          hitlLevel: 4, gated: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication',
        }),
        outcome: 'gated',
      })
    );
  });

  it('Level 4 does NOT auto-elevate destructive tools', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'delete_record', input: { id: '123' } },
    ];

    // Use escalation='exceptions' to skip sensitive work check
    const oversight = { ...mockOversight, escalation: 'exceptions' as const };
    const result = await service.checkHitlGate(toolCalls, oversight, 4, mockTools, 'tenant-123');

    // Falls through, no gate at Level 4 for destructive (only Level 2 gates destructive)
    // But should NOT have auto-elevated (no audit log for auto-elevation)
    expect(result.shouldGate).toBe(false);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({ action: 'delete_record', outcome: 'success', inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: false }) })
    );
  });

  it('Level 4 does NOT auto-elevate unclassified tools (categories undefined)', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'custom_tool', input: {} },
    ];

    // Use escalation='exceptions' to skip sensitive work check
    const oversight = { ...mockOversight, escalation: 'exceptions' as const };
    const result = await service.checkHitlGate(toolCalls, oversight, 4, mockTools, 'tenant-123');

    // Should NOT auto-elevate unknown tools - treat as potentially risky
    // Falls through to end without gating (no sensitive categories)
    expect(result.shouldGate).toBe(false);
    // Should NOT log auto-elevated audit (should log success at catch-all)
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({ action: 'custom_tool', outcome: 'success', inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: false }) })
    );
  });

  it('Level 4 mixed tools: any high-risk tool prevents auto-elevation', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_search', input: { query: 'test' } }, // low-risk
      { id: 'tc2', name: 'gmail_send', input: { to: 'test@example.com' } }, // high-risk
    ];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');

    // Should NOT auto-elevate because gmail_send has categories
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('sensitive_work');
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'gmail_send',
        inputArgs: expect.objectContaining({ gated: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' }),
        outcome: 'gated',
      })
    );
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'gmail_search',
        inputArgs: expect.objectContaining({ gated: true, matchedCategory: 'customerCommunication' }),
        outcome: 'gated',
      })
    );
  });

  it('Level 4 auto-elevated operations count towards rate limit', async () => {
    // First call should succeed
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_search', input: { query: 'test' } },
    ];

    const result1 = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');
    expect(result1.shouldGate).toBe(false);

    // Mock rate limit exceeded
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1001' }] });

    const result2 = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');
    expect(result2.shouldGate).toBe(true);
    expect(result2.reason).toBe('rate_limit_exceeded');
  });

  it('Level 4 with escalation=exceptions still auto-elevates low-risk tools', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'stripe_get_balance', input: {} },
    ];

    const oversight = { ...mockOversight, escalation: 'exceptions' as const };
    const result = await service.checkHitlGate(toolCalls, oversight, 4, mockTools, 'tenant-123');

    expect(result.shouldGate).toBe(false);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      null,
      'tenant-123',
      expect.objectContaining({
        action: 'stripe_get_balance',
        inputArgs: expect.objectContaining({
          hitlLevel: 4,
          autoElevated: true,
        }),
        outcome: 'success',
      })
    );

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls[0][1]).toEqual(['tenant-123', 4, 'stripe_get_balance', true]);
  });

  it('Level 4 high-risk tools pass when sensitive work category is disabled', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'gmail_send', input: { to: 'test@example.com' } },
    ];

    // Disable customerCommunication
    const oversight: OversightSettings = {
      ...mockOversight,
      sensitiveWork: {
        ...mockOversight.sensitiveWork,
        customerCommunication: false,
      },
    };

    const result = await service.checkHitlGate(toolCalls, oversight, 4, mockTools, 'tenant-123');

    // gmail_send has categories so doesn't auto-elevate, but category is disabled so passes
    expect(result.shouldGate).toBe(false);
    // Should log success at catch-all (tool has categories, not auto-elevated)
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({ action: 'gmail_send', outcome: 'success', inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: false }) })
    );
  });

  it('Level 4 with empty tool calls does not trigger auto-elevation', async () => {
    const toolCalls: ToolCallRequest[] = [];

    const result = await service.checkHitlGate(toolCalls, mockOversight, 4, mockTools, 'tenant-123');

    // Empty array returns early - no gating, no audit
    expect(result.shouldGate).toBe(false);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    // Should not have queried for rate limit either
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('HITL Levels 1–3 — Gate check audit logging', () => {
  let service: HitlEnforcementService;

  const mockTools: ModelTool[] = [
    { name: 'gmail_send_email', description: 'Send an email', categories: ['customerCommunication'] },
    { name: 'gmail_search', description: 'Search emails', categories: [] },
    { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Permanently deletes a record' },
    { name: 'bash', description: 'Run a shell command', categories: [] },
  ];

  const mockOversight: OversightSettings = {
    tenantId: 'tenant-123',
    autonomy: 'controlled',
    escalation: 'sensitive',
    sensitiveWork: {
      customerCommunication: true,
      financialActions: true,
      dataChanges: false,
      externalPublishing: true,
      hiringDecisions: false,
    },
    communication: 'review',
  };

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('Level 1 writes a gated audit record for each tool call', async () => {
    const toolCalls: ToolCallRequest[] = [{ id: 'tc1', name: 'bash', input: {} }];
    await service.checkHitlGate(toolCalls, mockOversight, 1, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'bash',
        inputArgs: expect.objectContaining({ hitlLevel: 1, gated: true, reason: 'level_1_gate' }),
        outcome: 'gated',
        triggeredBy: 'system',
      })
    );
  });

  it('Level 2 writes gated audit records for entire batch when destructive tool triggers gate', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'bash', input: {} },
      { id: 'tc2', name: 'delete_record', input: {} },
    ];
    await service.checkHitlGate(toolCalls, mockOversight, 2, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'delete_record',
        inputArgs: expect.objectContaining({
          hitlLevel: 2, gated: true, reason: 'destructive_gate', isDestructiveTrigger: true,
        }),
        outcome: 'gated',
      })
    );
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'bash',
        inputArgs: expect.objectContaining({ isDestructiveTrigger: false }),
        outcome: 'gated',
      })
    );
  });

  it('Level 2 non-destructive tools pass and write success audit records', async () => {
    const toolCalls: ToolCallRequest[] = [{ id: 'tc1', name: 'gmail_search', input: {} }];
    const oversight = { ...mockOversight, escalation: 'exceptions' as const };
    await service.checkHitlGate(toolCalls, oversight, 2, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'gmail_search',
        inputArgs: expect.objectContaining({ hitlLevel: 2, autoElevated: false }),
        outcome: 'success',
      })
    );
  });

  it('Level 3 sensitive work gate writes gated audit records for all tools in batch', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'bash', input: {} },
      { id: 'tc2', name: 'gmail_send_email', input: {} },
    ];
    await service.checkHitlGate(toolCalls, mockOversight, 3, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'gmail_send_email',
        inputArgs: expect.objectContaining({
          hitlLevel: 3, gated: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication',
        }),
        outcome: 'gated',
      })
    );
  });

  it('Super-destructive gate writes gated audit records even at level 5', async () => {
    const toolCalls: ToolCallRequest[] = [{ id: 'tc1', name: 'delete_tenant', input: {} }];
    await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-123',
      expect.objectContaining({
        action: 'delete_tenant',
        inputArgs: expect.objectContaining({ gated: true, reason: 'super_destructive_gate' }),
        outcome: 'gated',
      })
    );
  });
});

describe('approveRequest / rejectRequest audit logging', () => {
  let service: HitlEnforcementService;

  const TENANT_ID = '00000000-0000-0000-0000-000000000001';
  const AGENT_ID = '00000000-0000-0000-0000-000000000020';
  const APPROVAL_ID = '00000000-0000-0000-0000-000000000030';

  const pendingToolCalls: ToolCallRequest[] = [
    { id: 'tc1', name: 'bash', input: {} },
    { id: 'tc2', name: 'gmail_send_email', input: {} },
  ];

  function makeApprovalRow(overrides: Record<string, unknown> = {}) {
    const hash = (service as unknown as { hashToolCalls: (calls: ToolCallRequest[]) => string }).hashToolCalls(pendingToolCalls);
    return {
      id: APPROVAL_ID,
      tenant_id: TENANT_ID,
      workflow_id: '00000000-0000-0000-0000-000000000040',
      task_id: '00000000-0000-0000-0000-000000000050',
      agent_id: AGENT_ID,
      hitl_level: 1,
      pending_tool_calls: pendingToolCalls,
      tool_calls_hash: hash,
      reason: 'level_1_gate',
      status: 'pending',
      decided_by: null,
      decided_by_role: null,
      decision: null,
      rejection_reason: null,
      decided_at: null,
      idempotency_key: null,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('approveRequest writes a success audit record for each tool in the batch', async () => {
    const row = makeApprovalRow();
    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'approved', decision: 'approved' }] });

    await service.approveRequest({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      decidedBy: 'user-abc',
      decidedByRole: 'admin',
    });

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID,
      expect.objectContaining({
        internalAgentId: AGENT_ID,
        action: 'bash',
        inputArgs: expect.objectContaining({
          hitlLevel: 1, decision: 'approved', decidedBy: 'user-abc',
        }),
        outcome: 'success',
        triggeredBy: 'system',
      })
    );
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID,
      expect.objectContaining({ action: 'gmail_send_email', outcome: 'success' })
    );
  });

  it('rejectRequest writes a gated audit record for each tool in the batch', async () => {
    const row = makeApprovalRow();
    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'rejected', decision: 'rejected' }] });

    await service.rejectRequest({
      approvalId: APPROVAL_ID,
      decision: 'rejected',
      decidedBy: 'user-abc',
      decidedByRole: 'admin',
      rejectionReason: 'Wrong recipient',
    });

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID,
      expect.objectContaining({
        internalAgentId: AGENT_ID,
        action: 'bash',
        inputArgs: expect.objectContaining({
          hitlLevel: 1, decision: 'rejected', rejectionReason: 'Wrong recipient',
        }),
        outcome: 'gated',
        triggeredBy: 'system',
      })
    );
  });
});
