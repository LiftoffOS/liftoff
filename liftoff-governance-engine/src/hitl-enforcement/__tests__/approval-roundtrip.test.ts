// HITL Approval Round-Trip Tests
//
// Covers the full lifecycle of a HITL approval request:
//   - Create (happy path + idempotency)
//   - Approve (happy path, tamper detection, already-decided, expired)
//   - Reject (happy path with reason)
//   - Pending count and list queries
//   - Cross-tenant isolation
//
// All DB interactions are mocked via the global setup mock so no real
// Postgres is needed. Tests compose mock return sequences to simulate
// the exact SQL round-trips the service makes.

import { HitlEnforcementService } from '../service';
import { pool } from '../../infrastructure/database';
import {
  ToolCallRequest,
} from '../types';

jest.mock('../../infrastructure/database');
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));
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

const mockPool = pool as jest.Mocked<typeof pool>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000010';
const APPROVAL_ID = '00000000-0000-0000-0000-000000000020';

const SAMPLE_TOOL_CALLS: ToolCallRequest[] = [
  { id: 'tc-1', name: 'send_email', input: { to: 'test@example.com', subject: 'Hello' } },
];

function makeApprovalRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const svc = new HitlEnforcementService();
  const hash = svc.hashToolCalls(SAMPLE_TOOL_CALLS);
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000); // 5 min

  return {
    id: APPROVAL_ID,
    tenant_id: TENANT_A,
    workflow_id: 'wf-1',
    task_id: 'task-1',
    agent_id: AGENT_ID,
    hitl_level: 3,
    pending_tool_calls: JSON.stringify(SAMPLE_TOOL_CALLS),
    tool_calls_hash: hash,
    reason: 'test_gate',
    status: 'pending',
    decided_by: null,
    decided_by_role: null,
    decision: null,
    rejection_reason: null,
    decided_at: null,
    idempotency_key: null,
    expires_at: expires.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: createApprovalRequest
// ---------------------------------------------------------------------------

describe('createApprovalRequest', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('creates an approval request and returns the mapped object', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });

    const result = await svc.createApprovalRequest({
      tenantId: TENANT_A,
      workflowId: 'wf-1',
      taskId: 'task-1',
      agentId: AGENT_ID,
      hitlLevel: 3,
      pendingToolCalls: SAMPLE_TOOL_CALLS,
      reason: 'test_gate',
    });

    expect(result.id).toBe(APPROVAL_ID);
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.status).toBe('pending');
    expect(result.hitlLevel).toBe(3);
    expect(result.pendingToolCalls).toEqual(SAMPLE_TOOL_CALLS);
    expect(typeof result.toolCallsHash).toBe('string');
    expect(result.toolCallsHash).toHaveLength(64);  // SHA256 hex
  });

  it('computes and stores tool calls hash on create', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });

    await svc.createApprovalRequest({
      tenantId: TENANT_A,
      workflowId: 'wf-1',
      taskId: 'task-1',
      agentId: AGENT_ID,
      hitlLevel: 2,
      pendingToolCalls: SAMPLE_TOOL_CALLS,
      reason: 'destructive_gate',
    });

    const [sql, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/INSERT INTO hitl_approval_requests/);
    // params[5] is pending_tool_calls (JSON), params[6] is tool_calls_hash
    expect(params[6]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses idempotency key when provided', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow({ idempotency_key: 'idem-1' })] });

    await svc.createApprovalRequest({
      tenantId: TENANT_A,
      workflowId: 'wf-1',
      taskId: 'task-1',
      agentId: AGENT_ID,
      hitlLevel: 3,
      pendingToolCalls: SAMPLE_TOOL_CALLS,
      reason: 'test_gate',
      idempotencyKey: 'idem-1',
    });

    const [sql, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(idempotency_key\)/);
    expect(params[8]).toBe('idem-1');
  });

  it('stores null idempotency_key when not provided', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });

    await svc.createApprovalRequest({
      tenantId: TENANT_A,
      workflowId: 'wf-1',
      taskId: 'task-1',
      agentId: AGENT_ID,
      hitlLevel: 3,
      pendingToolCalls: SAMPLE_TOOL_CALLS,
      reason: 'test_gate',
    });

    const [, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(params[8]).toBeNull();
  });

  it('creates approval requests with all HITL levels', async () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      jest.clearAllMocks();
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [makeApprovalRow({ hitl_level: level })],
      });

      const result = await svc.createApprovalRequest({
        tenantId: TENANT_A,
        workflowId: 'wf-1',
        taskId: 'task-1',
        agentId: AGENT_ID,
        hitlLevel: level,
        pendingToolCalls: SAMPLE_TOOL_CALLS,
        reason: 'test_gate',
      });

      expect(result.hitlLevel).toBe(level);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: approveRequest — happy path + tamper detection
// ---------------------------------------------------------------------------

describe('approveRequest', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('approves a pending request and returns the updated record', async () => {
    const now = new Date();
    const pendingRow = makeApprovalRow();

    // getApprovalRequest → pending
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [pendingRow] });
    // UPDATE → approved
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({
        status: 'approved',
        decision: 'approved',
        decided_by: 'user-1',
        decided_by_role: 'admin',
        decided_at: now.toISOString(),
      })],
    });

    const result = await svc.approveRequest({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      decidedBy: 'user-1',
      decidedByRole: 'admin',
    });

    expect(result.status).toBe('approved');
    expect(result.decision).toBe('approved');
    expect(result.decidedBy).toBe('user-1');
  });

  it('throws when approval not found', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(
      svc.approveRequest({ approvalId: 'missing-id', decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow('Approval request not found');
  });

  it('throws when approval is already decided', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ status: 'approved', decision: 'approved', decided_at: new Date().toISOString() })],
    });

    await expect(
      svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow(/Cannot approve.*status is approved/);
  });

  it('throws when approval is expired', async () => {
    const pastDate = new Date(Date.now() - 10 * 60 * 1000);  // 10 min ago
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ expires_at: pastDate.toISOString() })],
    });

    await expect(
      svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow('expired');
  });

  it('throws TAMPER_DETECTED when tool_calls_hash does not match current hash', async () => {
    // Simulate a tampered row where the hash was computed for different tool calls
    const tamperedRow = makeApprovalRow({ tool_calls_hash: 'a'.repeat(64) });  // wrong hash
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [tamperedRow] });

    await expect(
      svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow('TAMPER_DETECTED');
  });

  it('tamper detection: passes when hash is correct', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ status: 'approved', decision: 'approved', decided_by: 'u', decided_by_role: 'admin', decided_at: new Date().toISOString() })],
    });

    // Should not throw — hash in makeApprovalRow is computed from SAMPLE_TOOL_CALLS
    const result = await svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' });
    expect(result.status).toBe('approved');
  });

  it('already-rejected approval cannot be re-approved', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ status: 'rejected', decision: 'rejected', decided_at: new Date().toISOString() })],
    });

    await expect(
      svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow(/Cannot approve.*status is rejected/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: rejectRequest — happy path
// ---------------------------------------------------------------------------

describe('rejectRequest', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('rejects a pending request and returns the updated record', async () => {
    const now = new Date();
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({
        status: 'rejected',
        decision: 'rejected',
        decided_by: 'manager-1',
        decided_by_role: 'admin',
        rejection_reason: 'Wrong recipient',
        decided_at: now.toISOString(),
      })],
    });

    const result = await svc.rejectRequest({
      approvalId: APPROVAL_ID,
      decision: 'rejected',
      decidedBy: 'manager-1',
      decidedByRole: 'admin',
      rejectionReason: 'Wrong recipient',
    });

    expect(result.status).toBe('rejected');
    expect(result.decision).toBe('rejected');
    expect(result.rejectionReason).toBe('Wrong recipient');
    expect(result.decidedBy).toBe('manager-1');
  });

  it('reject works without a rejection reason', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [makeApprovalRow()] });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ status: 'rejected', decision: 'rejected', decided_by: 'u', decided_by_role: 'member', decided_at: new Date().toISOString() })],
    });

    const result = await svc.rejectRequest({
      approvalId: APPROVAL_ID,
      decision: 'rejected',
      decidedBy: 'u',
      decidedByRole: 'member',
    });

    expect(result.status).toBe('rejected');
  });

  it('throws when approval not found', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(
      svc.rejectRequest({ approvalId: 'missing', decision: 'rejected', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow('Approval request not found');
  });

  it('throws when approval is already decided', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ status: 'approved', decision: 'approved', decided_at: new Date().toISOString() })],
    });

    await expect(
      svc.rejectRequest({ approvalId: APPROVAL_ID, decision: 'rejected', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow(/Cannot reject.*status is approved/);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: getPendingApprovalCount
// ---------------------------------------------------------------------------

describe('getPendingApprovalCount', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('returns the pending count for a tenant', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '7' }] });
    const count = await svc.getPendingApprovalCount(TENANT_A);
    expect(count).toBe(7);
  });

  it('returns 0 when there are no pending approvals', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const count = await svc.getPendingApprovalCount(TENANT_A);
    expect(count).toBe(0);
  });

  it('scopes the query to the given tenant_id', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '3' }] });
    await svc.getPendingApprovalCount(TENANT_A);

    const [sql, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(params[0]).toBe(TENANT_A);
    expect(sql).toMatch(/status = 'pending'/);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: listPendingApprovals — pagination
// ---------------------------------------------------------------------------

describe('listPendingApprovals', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('returns approvals with no cursor', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow(), makeApprovalRow({ id: 'ap-2' })],
    });

    const { approvals, nextCursor } = await svc.listPendingApprovals(TENANT_A);
    expect(approvals).toHaveLength(2);
    expect(nextCursor).toBeNull();
  });

  it('returns nextCursor when there are more results', async () => {
    // Return limit+1 rows to signal more pages (default limit=20)
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeApprovalRow({ id: `ap-${i}`, created_at: new Date(Date.now() - i * 1000).toISOString() }),
    );
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows });

    const { approvals, nextCursor } = await svc.listPendingApprovals(TENANT_A);
    expect(approvals).toHaveLength(20);
    expect(nextCursor).not.toBeNull();
  });

  it('uses cursor in WHERE clause when provided', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await svc.listPendingApprovals(TENANT_A, { cursor: '2026-01-01T00:00:00.000Z' });

    const [sql, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/AND created_at < \$2/);
    expect(params[1]).toBe('2026-01-01T00:00:00.000Z');
  });

  it('caps limit at 100', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await svc.listPendingApprovals(TENANT_A, { limit: 500 });

    const [sql, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/LIMIT \$\d/);
    const limitParam = params[params.length - 1];
    expect(limitParam).toBeLessThanOrEqual(101);  // limit+1 for pagination detection
  });

  it('scopes query to given tenant_id', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await svc.listPendingApprovals(TENANT_B);

    const [, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(params[0]).toBe(TENANT_B);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('Cross-tenant isolation', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('getApprovalRequest returns null for non-existent ID (DB returns no rows)', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const result = await svc.getApprovalRequest('cross-tenant-id');
    expect(result).toBeNull();
  });

  it('approveRequest throws "not found" when approval belongs to different tenant (DB returns 0 rows)', async () => {
    // Simulates the DB returning nothing for a cross-tenant lookup
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(
      svc.approveRequest({ approvalId: APPROVAL_ID, decision: 'approved', decidedBy: 'u', decidedByRole: 'admin' }),
    ).rejects.toThrow('Approval request not found');
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Hash determinism
// ---------------------------------------------------------------------------

describe('Tool call hash determinism', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); });

  it('same tool calls produce the same hash every time', () => {
    const hash1 = svc.hashToolCalls(SAMPLE_TOOL_CALLS);
    const hash2 = svc.hashToolCalls(SAMPLE_TOOL_CALLS);
    expect(hash1).toBe(hash2);
  });

  it('different input values produce different hashes', () => {
    const tc1: ToolCallRequest[] = [{ id: 'tc', name: 'send_email', input: { to: 'a@a.com' } }];
    const tc2: ToolCallRequest[] = [{ id: 'tc', name: 'send_email', input: { to: 'b@b.com' } }];
    expect(svc.hashToolCalls(tc1)).not.toBe(svc.hashToolCalls(tc2));
  });

  it('different tool names produce different hashes', () => {
    const tc1: ToolCallRequest[] = [{ id: 'tc', name: 'send_email', input: {} }];
    const tc2: ToolCallRequest[] = [{ id: 'tc', name: 'send_slack', input: {} }];
    expect(svc.hashToolCalls(tc1)).not.toBe(svc.hashToolCalls(tc2));
  });

  it('different order of tool calls produces different hashes', () => {
    const tc1: ToolCallRequest[] = [
      { id: 'a', name: 'tool_a', input: {} },
      { id: 'b', name: 'tool_b', input: {} },
    ];
    const tc2: ToolCallRequest[] = [
      { id: 'b', name: 'tool_b', input: {} },
      { id: 'a', name: 'tool_a', input: {} },
    ];
    expect(svc.hashToolCalls(tc1)).not.toBe(svc.hashToolCalls(tc2));
  });

  it('produces a 64-character lowercase hex string', () => {
    const hash = svc.hashToolCalls(SAMPLE_TOOL_CALLS);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: Approval for each HITL level triggers correct behavior on approve
// ---------------------------------------------------------------------------

describe('Approval works for each HITL level', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it.each([1, 2, 3, 4, 5])('level %i approval succeeds', async (level) => {
    const row = makeApprovalRow({ hitl_level: level });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [row] });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ hitl_level: level, status: 'approved', decision: 'approved', decided_by: 'u', decided_by_role: 'admin', decided_at: new Date().toISOString() })],
    });

    const result = await svc.approveRequest({
      approvalId: APPROVAL_ID,
      decision: 'approved',
      decidedBy: 'u',
      decidedByRole: 'admin',
    });

    expect(result.status).toBe('approved');
    expect(result.hitlLevel).toBe(level);
  });

  it.each([1, 2, 3, 4, 5])('level %i rejection succeeds', async (level) => {
    const row = makeApprovalRow({ hitl_level: level });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [row] });
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [makeApprovalRow({ hitl_level: level, status: 'rejected', decision: 'rejected', decided_by: 'u', decided_by_role: 'admin', rejection_reason: 'too risky', decided_at: new Date().toISOString() })],
    });

    const result = await svc.rejectRequest({
      approvalId: APPROVAL_ID,
      decision: 'rejected',
      decidedBy: 'u',
      decidedByRole: 'admin',
      rejectionReason: 'too risky',
    });

    expect(result.status).toBe('rejected');
    expect(result.hitlLevel).toBe(level);
    expect(result.rejectionReason).toBe('too risky');
  });
});
