// HITL Enforcement Service Tests
// Per implementation plan: [TE-001] Phase 1.8

import {
  ToolCallRequest,
  ModelTool,
  OversightSettings,
  SUPER_DESTRUCTIVE_OPERATIONS,
  HitlGateError,
} from '../types';
import { HitlEnforcementService, standingApprovalAllowed } from '../service';
import { classifyVendorMcpTool } from '../../agent-execution/adapter/vendor-mcp-classify';
import { composeToolName } from '../../agent-execution/tool-name-sanitizer';

// Mock database pool. The query mock is shared between `pool.query` and
// the client passed into withTenantScope, so existing tests that drive
// pool.query continue to work for both pool-direct paths and tenant-scoped
// paths (getRecentOperationCount, recordRateLimitEvent).
jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [{ count: '0' }] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (
      _tenantId: string,
      fn: (client: { query: typeof sharedQuery }) => Promise<unknown>,
    ) => fn({ query: sharedQuery })),
  };
});

// Mock audit logging
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// Mock governance-service-client for standing approval policy tests
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
}));

// The contract check's vendor call (contract-check.ts). Answers `within`
// unless a test scripts otherwise; every existing test above passes no
// contract, so it is never reached there.
const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));

import { pool } from '../../infrastructure/database';
import { insertAuditLog } from '../../audit/service';
import { getGovernanceApprovalPolicy } from '../../governance/governance-service-client';

const mockGetGovernanceApprovalPolicy = getGovernanceApprovalPolicy as jest.MockedFunction<typeof getGovernanceApprovalPolicy>;

const mockPool = pool as jest.Mocked<typeof pool>;
const mockInsertAuditLog = insertAuditLog as jest.MockedFunction<typeof insertAuditLog>;


// workflow_id and task_id are nullable uuid columns. A uuid column takes a
// real id or NULL and rejects an empty string, so the INSERT must translate a
// blank into NULL rather than pass it through — a caller whose context was
// rebuilt without the ids can hand it one.
describe('createApprovalRequest writes real ids or NULL to the uuid columns, never a blank', () => {
  const baseInput = {
    tenantId: 't1', agentId: 'a1', hitlLevel: 2,
    pendingToolCalls: [{ id: 'pc1', name: 'run_capability', input: { capabilityId: 'cap_w.x' } }],
    reason: 'capability_requires_approval',
  };
  const insertedRow = { id: 'appr-1', tenant_id: 't1', agent_id: 'a1', hitl_level: 2, pending_tool_calls: [], status: 'pending' };

  function insertParams(): unknown[] {
    const call = (pool.query as jest.Mock).mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO hitl_approval_requests'),
    );
    expect(call).toBeDefined();
    return call![1] as unknown[];
  }

  beforeEach(() => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [insertedRow] });
  });

  it('translates blank ids into NULL', async () => {
    const service = new HitlEnforcementService();
    await service.createApprovalRequest({ ...baseInput, workflowId: '', taskId: '' } as never);
    const params = insertParams();
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
  });

  it('passes real ids through unchanged', async () => {
    const service = new HitlEnforcementService();
    await service.createApprovalRequest({
      ...baseInput,
      workflowId: '8d48512f-c961-4cee-87f2-a71e2664e8af',
      taskId: 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9',
    } as never);
    const params = insertParams();
    expect(params[1]).toBe('8d48512f-c961-4cee-87f2-a71e2664e8af');
    expect(params[2]).toBe('d347ba93-7e22-4cbe-8e6c-0f3ad65852a9');
  });

  it('translates a non-uuid label into NULL, the same as a blank', async () => {
    const service = new HitlEnforcementService();
    await service.createApprovalRequest({ ...baseInput, workflowId: 'resume-hitl-abc', taskId: 'not-a-uuid' } as never);
    const params = insertParams();
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
  });

  it('treats an absent id as NULL too', async () => {
    const service = new HitlEnforcementService();
    await service.createApprovalRequest({ ...baseInput, workflowId: undefined, taskId: null } as never);
    const params = insertParams();
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
  });
});

describe('HitlEnforcementService', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    // Reset rate limit mock to return 0 operations by default
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
    // Default: no standing policy (fail-open — gate fires normally)
    mockGetGovernanceApprovalPolicy.mockResolvedValue(null);
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
      // Runtime tool names are never bare — they carry the dispatch prefix.
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
    });

    describe('merge-to-main gate (recognised by EFFECT, not by name)', () => {
      const mergeOversight: OversightSettings = {
        ...mockOversight,
        sensitiveWork: { ...mockOversight.sensitiveWork, mergeToMain: true },
      };

      it.each([
        // bare names (legacy)
        'merge_pull_request', 'squash_and_merge_pull_request', 'merge_branch',
        // connector-catalog / sandbox prefix: <alias>__<tool>
        'github-ab12__merge_pull_request',
        // Claude Agent SDK vendor-MCP prefix: mcp__<server>__<tool>
        'mcp__github-ab12__merge_pull_request',
        // Claude Agent SDK in-process prefix: mcp__liftoff-tools-<tenant>__<alias>__<tool>
        'mcp__liftoff-tools-t1__github-ab12__squash_and_merge_pull_request',
      ])(
        'fires merge_to_main gate for tool name "%s" when mergeToMain is enabled',
        async (toolName) => {
          const result = await service.checkHitlGate(
            [{ id: 'tc1', name: toolName, input: { pr: 1 } }],
            mergeOversight,
            5,  // even fully autonomous — merge MUST gate
            [],
            'tenant-123',
            'agent-abc',
          );
          expect(result.shouldGate).toBe(true);
          expect(result.reason).toBe('merge_to_main');
        },
      );

      // INVERTED DELIBERATELY. This asserted that switching the toggle off
      // removed the merge gate entirely. That position is the one being
      // deleted: a hard invariant a tenant can turn off is not one, and this
      // control can be off by accident — if the category ships `false`, every
      // tenant created before it, and every one after who never opens the
      // page, has merges ungoverned while the page says otherwise.
      //
      // It matters more under declared scope, not less: with approved work
      // exempted from the category path, the toggle would have been the only
      // thing between a reviewer and merging the pull request that woke it.
      //
      // The escape hatch moved rather than vanished — a standing per-agent
      // approval policy still clears it, which is asserted in
      // declared-scope-gate.test.ts. Absolute means the bypass is a deliberate
      // per-agent act, not a workspace checkbox.
      it('fires EVEN WHEN mergeToMain is disabled — the toggle cannot remove it', async () => {
        const oversight: OversightSettings = {
          ...mockOversight,
          escalation: 'exceptions',
          sensitiveWork: { ...mockOversight.sensitiveWork, mergeToMain: false },
        };
        const result = await service.checkHitlGate(
          [{ id: 'tc1', name: 'merge_pull_request', input: {} }],
          oversight,
          5,
          [],
          'tenant-123',
          'agent-abc',
        );
        expect(result.shouldGate).toBe(true);
        expect(result.reason).toBe('merge_to_main');
      });

      it('does NOT fire for non-merge tools when mergeToMain is enabled', async () => {
        const oversight: OversightSettings = {
          ...mergeOversight,
          escalation: 'exceptions',
        };
        const result = await service.checkHitlGate(
          [{ id: 'tc1', name: 'gmail_search', input: {} }],
          oversight,
          5,
          mockTools,
          'tenant-123',
          'agent-abc',
        );
        expect(result.shouldGate).toBe(false);
      });

      it('fires BEFORE the autonomy-based level-4/5 shortcuts (autonomous agents cannot bypass)', async () => {
        // Level 5 is fully autonomous — the level-5 section (3) early-returns
        // shouldGate:false. The merge-to-main check at section 1a must fire
        // BEFORE that to catch this.
        const result = await service.checkHitlGate(
          [{ id: 'tc1', name: 'merge_branch', input: { base: 'main', head: 'feat-x' } }],
          { ...mergeOversight, autonomy: 'autonomous' },
          5,
          [],
          'tenant-123',
          'agent-abc',
        );
        expect(result.shouldGate).toBe(true);
        expect(result.reason).toBe('merge_to_main');
      });

      it('handles missing mergeToMain toggle (backward compat with cache rows that pre-date the field)', async () => {
        const oversight = {
          ...mockOversight,
          escalation: 'exceptions' as const,
          sensitiveWork: { ...mockOversight.sensitiveWork },  // mergeToMain absent
        };
        // Cast through unknown because the type marks mergeToMain optional.
        // Pre-fix cache rows wouldn't carry it; check we don't blow up.
        delete (oversight.sensitiveWork as Record<string, boolean | undefined>).mergeToMain;
        const result = await service.checkHitlGate(
          [{ id: 'tc1', name: 'merge_pull_request', input: {} }],
          oversight,
          5,
          [],
          'tenant-123',
          'agent-abc',
        );
        // A cache row that predates the field is now the SAFE case rather than
        // the ungoverned one. This is the exact population the original defect
        // hit: "five categories on, mergeToMain absent from the row entirely,
        // an operator reasonably believing merges were governed because that is
        // what the page is for."
        expect(result.shouldGate).toBe(true);
        expect(result.reason).toBe('merge_to_main');
      });
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

  // SE-002: Bookkeeping moved out of audit_logs into hitl_rate_limit_events
  // (migration 100). audit_logs must NOT be written from this path.
  it('Level 5 records rate-limit events (not audit_logs) for each operation', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'send_email', input: { to: 'test@example.com' } },
      { id: 'tc2', name: 'create_charge', input: { amount: 100 } },
    ];

    await service.checkHitlGate(toolCalls, mockOversight, 5, mockTools, 'tenant-123');

    // No audit_logs writes from this path anymore.
    expect(mockInsertAuditLog).not.toHaveBeenCalled();

    // Two INSERTs into hitl_rate_limit_events. The first call is the count
    // query in getRecentOperationCount; subsequent calls are the inserts.
    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls).toHaveLength(2);

    expect(insertCalls[0][1]).toEqual([
      'tenant-123',
      null, // agentId
      5,
      'send_email',
      false, // not auto-elevated at Level 5
    ]);
    expect(insertCalls[1][1]).toEqual([
      'tenant-123',
      null,
      5,
      'create_charge',
      false,
    ]);
  });

  // SE-001: getRecentOperationCount reads from the new table.
  it('getRecentOperationCount queries hitl_rate_limit_events', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '42' }] });

    const count = await service.getRecentOperationCount('tenant-123', '1h');

    expect(count).toBe(42);
    const selectCall = (mockPool.query as jest.Mock).mock.calls[0];
    expect(selectCall[0]).toContain('FROM hitl_rate_limit_events');
    expect(selectCall[0]).not.toContain('audit_logs');
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
    // No audit_logs writes — bookkeeping moved to hitl_rate_limit_events.
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual([
      'tenant-123',
      null,
      4,
      'gmail_search',
      true, // auto-elevated
    ]);
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
    // Should NOT log auto-elevated audit
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('Level 4 does NOT auto-elevate destructive tools', async () => {
    const toolCalls: ToolCallRequest[] = [
      { id: 'tc1', name: 'delete_record', input: { id: '123' } },
    ];

    // Use escalation='exceptions' to skip sensitive work check
    const oversight = { ...mockOversight, escalation: 'exceptions' as const };
    const result = await service.checkHitlGate(toolCalls, oversight, 4, mockTools, 'tenant-123');

    // Falls through, no gate at Level 4 for destructive (only Level 2 gates destructive)
    // But should NOT have auto-elevated (no audit log)
    expect(result.shouldGate).toBe(false);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
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
    // Should NOT log auto-elevated audit
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
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
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
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
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO hitl_rate_limit_events')
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([
      'tenant-123',
      null,
      4,
      'stripe_get_balance',
      true,
    ]);
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
    // No auto-elevation audit (tool has categories)
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
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

  // ─── Standing approval policy (alwaysApply) ────────────────────────────────

  describe('standing approval policy (auto-approve / auto-reject by policy)', () => {
    const sensitiveOversight: OversightSettings = {
      tenantId: 'tenant-123',
      autonomy: 'balanced',
      escalation: 'sensitive',
      sensitiveWork: {
        customerCommunication: true,
        financialActions: false,
        hiringDecisions: false,
        dataChanges: false,
        externalPublishing: false,
      },
      communication: 'auto',
    };

    beforeEach(() => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue(null);
    });

    it('auto-approves at level 1 when policy decision is approved', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'send_email', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 1, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(false);
      expect(mockGetGovernanceApprovalPolicy).toHaveBeenCalledWith('tenant-123', 'agent-abc', 'level_1_gate');
    });

    it('writes audit log entry when auto-approving by policy', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'send_email', input: {} }];
      await service.checkHitlGate(
        toolCalls, sensitiveOversight, 1, mockTools, 'tenant-123', 'agent-abc',
      );

      // insertAuditLog is called asynchronously with .catch() so give it a tick
      await new Promise(r => setImmediate(r));
      expect(mockInsertAuditLog).toHaveBeenCalledWith(
        null,
        'tenant-123',
        expect.objectContaining({ action: 'hitl_auto_approved_by_policy' }),
      );
    });

    it('auto-rejects at level 1 when policy decision is rejected', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'rejected' } as never);

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'send_email', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 1, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('level_1_gate');
    });

    it('fires gate normally when policy returns null (fail-open)', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue(null);

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'send_email', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 1, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(true);
    });

    it('fires gate normally when governance client throws (fail-open)', async () => {
      mockGetGovernanceApprovalPolicy.mockRejectedValue(new Error('network error'));

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'send_email', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 1, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(true);
    });

    it('auto-approves level 2 destructive gate when policy is approved', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'delete_record', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 2, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(false);
      expect(mockGetGovernanceApprovalPolicy).toHaveBeenCalledWith('tenant-123', 'agent-abc', 'destructive_gate');
    });

    it('auto-approves sensitive_work gate when policy is approved', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      // gmail_send has customerCommunication category (Level 4 describe's mockTools)
      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'gmail_send', input: {} }];
      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 3, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(false);
      expect(mockGetGovernanceApprovalPolicy).toHaveBeenCalledWith('tenant-123', 'agent-abc', 'sensitive_work');
    });

    it('does NOT query policy when no gate reason would apply (allowed tool at level 3)', async () => {
      // gmail_search has no categories, so level 3 won't gate it
      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'gmail_search', input: {} }];
      await service.checkHitlGate(
        toolCalls, sensitiveOversight, 3, mockTools, 'tenant-123', 'agent-abc',
      );

      expect(mockGetGovernanceApprovalPolicy).not.toHaveBeenCalled();
    });

    it('does NOT apply policy bypass for super_destructive operations', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      const superDestructiveName = [...SUPER_DESTRUCTIVE_OPERATIONS][0];
      const superTool: ModelTool = {
        name: superDestructiveName,
        description: `⚠️ DESTRUCTIVE: ${superDestructiveName}`,
      };
      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: superDestructiveName, input: {} }];

      const result = await service.checkHitlGate(
        toolCalls, sensitiveOversight, 5, [superTool], 'tenant-123', 'agent-abc',
      );

      // Super-destructive gate always fires regardless of policy
      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('super_destructive_gate');
    });

    it('auto-approves merge_to_main gate when policy is approved', async () => {
      // Ops team explicitly approves a code-bot agent to auto-merge
      // within scope — standing-policy bypass applies even on the
      // name-based merge gate.
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);

      const mergeOversight: OversightSettings = {
        ...sensitiveOversight,
        sensitiveWork: { ...sensitiveOversight.sensitiveWork, mergeToMain: true },
      };
      const toolCalls: ToolCallRequest[] = [{ id: 'c1', name: 'merge_pull_request', input: {} }];

      const result = await service.checkHitlGate(
        toolCalls, mergeOversight, 5, [], 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(false);
      expect(mockGetGovernanceApprovalPolicy).toHaveBeenCalledWith('tenant-123', 'agent-abc', 'merge_to_main');
    });

    it('fires merge_to_main gate when policy is rejected (no policy bypass)', async () => {
      mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'rejected' } as never);

      const mergeOversight: OversightSettings = {
        ...sensitiveOversight,
        sensitiveWork: { ...sensitiveOversight.sensitiveWork, mergeToMain: true },
      };
      const result = await service.checkHitlGate(
        [{ id: 'c1', name: 'merge_pull_request', input: {} }],
        mergeOversight, 5, [], 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('merge_to_main');
    });

    it('fires merge_to_main gate when policy lookup throws (fail-open)', async () => {
      mockGetGovernanceApprovalPolicy.mockRejectedValue(new Error('governance-engine down'));

      const mergeOversight: OversightSettings = {
        ...sensitiveOversight,
        sensitiveWork: { ...sensitiveOversight.sensitiveWork, mergeToMain: true },
      };
      const result = await service.checkHitlGate(
        [{ id: 'c1', name: 'merge_pull_request', input: {} }],
        mergeOversight, 5, [], 'tenant-123', 'agent-abc',
      );

      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('merge_to_main');
    });
  });
});

// The vendor-MCP classifier emits the EXACT SensitivityCategory strings
// checkHitlGate matches on, so an enumerated + classified vendor tool actually
// gates end-to-end. This pins the string contract — if classifyVendorMcpTool
// emitted 'data_changes' instead of 'dataChanges', every link's isolated test
// would still pass but real gating would silently break; this catches that.
describe('checkHitlGate — vendor MCP classification → category gating', () => {
  const oversight: OversightSettings = {
    tenantId: 'tenant-123',
    autonomy: 'balanced',
    escalation: 'sensitive',
    sensitiveWork: {
      customerCommunication: false,
      financialActions: true,
      dataChanges: true,
      externalPublishing: false,
      hiringDecisions: false,
    },
    communication: 'auto',
  };

  function vendorModelTool(serverId: string, bareName: string): ModelTool {
    const c = classifyVendorMcpTool(serverId, bareName);
    return {
      name: composeToolName(serverId, bareName),
      description: c.destructive ? `⚠️ DESTRUCTIVE: ${bareName}` : bareName,
      categories: c.categories,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGovernanceApprovalPolicy.mockResolvedValue(null);
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('gates a classified destructive vendor tool (delete_repo → dataChanges)', async () => {
    const svc = new HitlEnforcementService();
    const tool = vendorModelTool('github-x', 'delete_repo');
    const result = await svc.checkHitlGate(
      [{ id: 't', name: tool.name, input: {} }], oversight, 3, [tool], 'tenant-123',
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('sensitive_work');
    expect(result.matchedCategory).toBe('dataChanges');
  });

  it('gates a classified financial vendor tool (create_refund → financialActions)', async () => {
    const svc = new HitlEnforcementService();
    const tool = vendorModelTool('stripe-x', 'create_refund');
    const result = await svc.checkHitlGate(
      [{ id: 't', name: tool.name, input: {} }], oversight, 3, [tool], 'tenant-123',
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('sensitive_work');
  });

  it('does NOT gate an unclassified read-only vendor tool (get_issue → []) — the boundary', async () => {
    const svc = new HitlEnforcementService();
    const tool = vendorModelTool('github-x', 'get_issue');
    const result = await svc.checkHitlGate(
      [{ id: 't', name: tool.name, input: {} }], oversight, 3, [tool], 'tenant-123',
    );
    expect(result.shouldGate).toBe(false);
  });
});

describe('standingApprovalAllowed (always-apply suppression policy)', () => {
  it('allows a standing decision for low-risk gate reasons', () => {
    for (const r of ['level_1_gate', 'destructive_gate', 'communication_review', 'rate_limit_exceeded']) {
      expect(standingApprovalAllowed(r)).toBe(true);
    }
  });
  it('suppresses a standing decision for high-risk gate reasons (fresh decision each time)', () => {
    for (const r of ['super_destructive_gate', 'merge_to_main', 'sensitive_work']) {
      expect(standingApprovalAllowed(r)).toBe(false);
    }
  });
});


// ── The contract check, at the one decision point ─────────────────────────
//
// `checkHitlGate` routes every allow after its hard invariants through
// `allow()`; the check runs there and nowhere else (contract-check.ts).
describe('checkHitlGate runs the contract check on every allow after the hard invariants', () => {
  let service: HitlEnforcementService;
  const tools: ModelTool[] = [
    { name: 'crm__update_contact', description: 'Update a contact', categories: ['dataChanges'], effect: 'write' },
    { name: 'crm__get_contact', description: 'Read a contact', categories: ['read'], effect: 'read' },
    { name: 'notes__append', description: 'Append a note', categories: [], effect: 'write' },
    { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Delete a record', categories: [] },
  ];
  const oversightOn: OversightSettings = {
    tenantId: 'tenant-cc', autonomy: 'balanced', escalation: 'sensitive',
    sensitiveWork: { dataChanges: true }, communication: 'auto',
  };
  const oversightOff: OversightSettings = { ...oversightOn, escalation: 'exceptions', sensitiveWork: {} };
  const contract = { kind: 'instructions' as const, instructions: 'Keep CRM contacts current.', role: 'You are the CRM Assistant.' };
  const write: ToolCallRequest = { id: 'w1', name: 'crm__update_contact', input: { id: 'c1', phone: '555' } };
  const read: ToolCallRequest = { id: 'r1', name: 'crm__get_contact', input: { id: 'c1' } };
  const lowRiskWrite: ToolCallRequest = { id: 'n1', name: 'notes__append', input: { text: 'x' } };

  const outside = (p: number) => ({
    answers: { relation_0: { choice: 'outside', confidence: 0.9, probabilities: { within: 1 - p, outside: p, unclear: 0 } } },
    model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
  });
  const within = () => ({
    answers: { relation_0: { choice: 'within', confidence: 0.9, probabilities: { within: 0.95, outside: 0.05, unclear: 0 } } },
    model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
  });

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
    delete process.env.TR_CONTRACT_CHECK_ENABLED;
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
    mockGetGovernanceApprovalPolicy.mockResolvedValue(null);
    mockAsk.mockResolvedValue(within());
  });

  it('never runs before the hard invariants: a super_destructive_gate decision is untouched and no request is made', async () => {
    mockAsk.mockResolvedValue(outside(0.99));
    const result = await service.checkHitlGate(
      [{ id: 'd1', name: 'delete_tenant', input: {} }], oversightOff, 5, tools, 'tenant-cc', 'agent-1', { contract },
    );
    expect(result).toEqual({ shouldGate: true, reason: 'super_destructive_gate' });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('runs on the level-5 allow', async () => {
    mockAsk.mockResolvedValue(outside(0.9));
    const result = await service.checkHitlGate([write], oversightOn, 5, tools, 'tenant-cc', 'agent-1', { contract, invocationId: 'inv-1' });
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('contract_deviation');
    expect(result.detail).toBe('crm__update_contact is outside the instructions (p=0.90)');
    expect(result.context).toEqual({ contract_check: { kind: 'instructions', p: 0.9 } });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][2]).toMatchObject({ tenantId: 'tenant-cc', runtimeAgentId: 'agent-1', invocationId: 'inv-1' });
  });

  it('runs on the level-4 low-risk allow', async () => {
    mockAsk.mockResolvedValue(outside(0.85));
    const result = await service.checkHitlGate([lowRiskWrite], oversightOn, 4, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result.reason).toBe('contract_deviation');
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('runs on the no-gate-reason allow', async () => {
    mockAsk.mockResolvedValue(outside(0.85));
    const result = await service.checkHitlGate([write], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result.reason).toBe('contract_deviation');
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('runs on the declared-scope allow', async () => {
    mockAsk.mockResolvedValue(outside(0.85));
    const declaredStep = { stepId: 's3', toolName: 'crm__update_contact', argumentsAuthored: true, description: 'Update the contact' };
    const result = await service.checkHitlGate([write], oversightOn, 3, tools, 'tenant-cc', 'agent-1', {
      declaredStep,
      contract: { kind: 'step', stepId: 's3', description: 'Update the contact', toolName: 'crm__update_contact' },
    });
    expect(result.reason).toBe('contract_deviation');
    expect(result.context).toEqual({ contract_check: { kind: 'step', stepId: 's3', p: 0.85 } });
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('runs on the standing-approval allow', async () => {
    mockGetGovernanceApprovalPolicy.mockResolvedValue({ decision: 'approved' } as never);
    mockAsk.mockResolvedValue(outside(0.85));
    const result = await service.checkHitlGate([write], oversightOn, 3, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result.reason).toBe('contract_deviation');
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('runs on none of the gate paths: a sensitive_work gate, a level-1 gate and a destructive gate are returned as they are', async () => {
    mockAsk.mockResolvedValue(outside(0.99));
    expect(await service.checkHitlGate([write], oversightOn, 3, tools, 'tenant-cc', 'agent-1', { contract }))
      .toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'dataChanges' });
    expect(await service.checkHitlGate([write], oversightOff, 1, tools, 'tenant-cc', 'agent-1', { contract }))
      .toEqual({ shouldGate: true, reason: 'level_1_gate' });
    expect(await service.checkHitlGate([{ id: 'x', name: 'delete_record', input: {} }], oversightOff, 2, tools, 'tenant-cc', 'agent-1', { contract }))
      .toEqual({ shouldGate: true, reason: 'destructive_gate' });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('an empty batch is excluded', async () => {
    const result = await service.checkHitlGate([], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result).toEqual({ shouldGate: false });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('a read-only batch makes no request', async () => {
    const result = await service.checkHitlGate([read], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result).toEqual({ shouldGate: false });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('a mixed batch with one confident outside gates and names that call', async () => {
    mockAsk.mockResolvedValue({
      answers: {
        relation_0: { choice: 'within', confidence: 0.9, probabilities: { within: 0.97, outside: 0.03, unclear: 0 } },
        relation_1: { choice: 'outside', confidence: 0.9, probabilities: { within: 0.1, outside: 0.86, unclear: 0.04 } },
      },
      model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
    });
    const result = await service.checkHitlGate([lowRiskWrite, read, write], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract });
    expect(result.reason).toBe('contract_deviation');
    expect(result.detail).toContain('crm__update_contact');
    const set = mockAsk.mock.calls[0][0] as { questions: Record<string, unknown> };
    expect(Object.keys(set.questions)).toEqual(['relation_0', 'relation_1']);
  });

  it('within leaves every allow exactly as it was', async () => {
    expect(await service.checkHitlGate([write], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract })).toEqual({ shouldGate: false });
    expect(await service.checkHitlGate([write], oversightOn, 5, tools, 'tenant-cc', 'agent-1', { contract })).toEqual({ shouldGate: false });
    expect(mockAsk).toHaveBeenCalledTimes(2);
  });

  it('a caller with no contract gets today\'s decision and no request', async () => {
    mockAsk.mockResolvedValue(outside(0.99));
    expect(await service.checkHitlGate([write], oversightOff, 3, tools, 'tenant-cc', 'agent-1')).toEqual({ shouldGate: false });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('the kill makes checkHitlGate today\'s gate', async () => {
    process.env.TR_CONTRACT_CHECK_ENABLED = '0';
    mockAsk.mockResolvedValue(outside(0.99));
    expect(await service.checkHitlGate([write], oversightOff, 3, tools, 'tenant-cc', 'agent-1', { contract })).toEqual({ shouldGate: false });
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
