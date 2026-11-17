// Governance Trajectory Evaluation Suite — Level 2 (multi-turn, integration, CI-blocking).
//
// Full approval chain: checkHitlGate → createApprovalRequest → approve/reject (tamper check)
// → pending count decremented.
//
// Connects to the Docker governance DB via GOVERNANCE_DB_* env vars set by
// src/test-utils/integration-setup.ts (or test environment). The module pool is
// lazy-initialized so it picks up those env vars before first use.
//
// Tests skip gracefully when the governance DB is unreachable (ECONNREFUSED) —
// CI without Docker will skip rather than fail.

import { hitlEnforcementService } from '../../service.js';
import type { OversightSettings, ToolCallRequest, ModelTool } from '../../types.js';
import { pool } from '../../../infrastructure/database.js';

const TENANT = 'traj-eval-tenant';

const OVERSIGHT: OversightSettings = {
  tenantId: TENANT,
  autonomy: 'balanced',
  escalation: 'important',
  sensitiveWork: {
    customerCommunication: false,
    financialActions: false,
    dataChanges: false,
    externalPublishing: false,
    hiringDecisions: false,
  },
  communication: 'review',
};

const DESTRUCTIVE_CALL: ToolCallRequest = {
  id: 'tc-traj',
  name: 'write_file',
  input: { path: '/tmp/x' },
};
const DESTRUCTIVE_TOOL: ModelTool = {
  name: 'write_file',
  description: '⚠️ DESTRUCTIVE: overwrites file',
};

// Skip test if Docker DB is unreachable (CI without Docker will skip gracefully)
function maybe(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    try {
      await fn();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        console.warn(`Skipping "${name}": governance DB not reachable`);
        return;
      }
      throw e;
    }
  });
}

beforeAll(async () => {
  // Seed tenant oversight cache so resolveHitlLevel() finds the right level.
  // ON CONFLICT DO NOTHING so parallel test runs don't stomp each other.
  try {
    await pool.query(
      `INSERT INTO tenant_oversight_cache
         (tenant_id, entity_version, autonomy, escalation, sensitive_work, communication, synced_at)
       VALUES ($1, 1, 'balanced', 'important',
         '{"customerCommunication":false,"financialActions":false,"dataChanges":false,"externalPublishing":false,"hiringDecisions":false}',
         'review', NOW())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANT],
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw e;
    // DB unreachable — beforeAll skipped; individual tests will skip via maybe()
  }
});

afterAll(async () => {
  try {
    await pool.query(
      `DELETE FROM hitl_approval_requests WHERE tenant_id = $1`,
      [TENANT],
    );
    // audit_logs is append-only (migration 019); the only sanctioned delete is
    // the retention purge, which sets app.audit_retention_purge. Mirror that in
    // a single transaction so this teardown is admitted by the guard.
    const auditClient = await pool.connect();
    try {
      await auditClient.query('BEGIN');
      await auditClient.query(`SELECT set_config('app.audit_retention_purge', 'on', true)`);
      await auditClient.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [TENANT]);
      await auditClient.query('COMMIT');
    } finally {
      auditClient.release();
    }
    await pool.query(
      `DELETE FROM tenant_oversight_cache WHERE tenant_id = $1`,
      [TENANT],
    );
  } catch {
    // Best-effort cleanup — ignore DB errors during teardown
  }
});

// ── Trajectory 1: Level 2 gate → approve ────────────────────────────────────

describe('Trajectory: Level 2 gate → approve path', () => {
  maybe('gate fires, approval created, approved, count decremented', async () => {
    const gate = await hitlEnforcementService.checkHitlGate(
      [DESTRUCTIVE_CALL],
      OVERSIGHT,
      2,
      [DESTRUCTIVE_TOOL],
      TENANT,
    );
    expect(gate.shouldGate).toBe(true);

    const approval = await hitlEnforcementService.createApprovalRequest({
      tenantId: TENANT,
      agentId: 'test-agent-1',
      workflowId: 'wf-traj-001',
      taskId: 'task-traj-001',
      hitlLevel: 2,
      pendingToolCalls: [DESTRUCTIVE_CALL],
      reason: gate.reason ?? 'destructive_gate',
      idempotencyKey: `traj-approve-${Date.now()}`,
    });
    expect(approval.id).toBeTruthy();
    expect(approval.status).toBe('pending');

    const approved = await hitlEnforcementService.approveRequest({
      approvalId: approval.id,
      decision: 'approved',
      decidedBy: 'user-reviewer',
      decidedByRole: 'admin',
    });
    expect(approved.status).toBe('approved');
    expect(approved.decision).toBe('approved');
    expect(approved.decidedBy).toBe('user-reviewer');

    const count = await hitlEnforcementService.getPendingApprovalCount(TENANT);
    expect(count).toBe(0);
  });
});

// ── Trajectory 2: Level 2 gate → reject ─────────────────────────────────────

describe('Trajectory: Level 2 gate → reject path', () => {
  maybe('approval request can be rejected with a reason', async () => {
    const approval = await hitlEnforcementService.createApprovalRequest({
      tenantId: TENANT,
      agentId: 'test-agent-2',
      workflowId: 'wf-traj-002',
      taskId: 'task-traj-002',
      hitlLevel: 2,
      pendingToolCalls: [DESTRUCTIVE_CALL],
      reason: 'destructive_gate',
      idempotencyKey: `traj-reject-${Date.now()}`,
    });

    const rejected = await hitlEnforcementService.rejectRequest({
      approvalId: approval.id,
      decision: 'rejected',
      decidedBy: 'user-reviewer',
      decidedByRole: 'operator',
      rejectionReason: 'too risky in production',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('too risky in production');
    expect(rejected.decision).toBe('rejected');
  });
});

// ── Trajectory 3: Tamper detection ──────────────────────────────────────────

describe('Trajectory: tamper detection on approve', () => {
  maybe('approving a tampered approval throws', async () => {
    const approval = await hitlEnforcementService.createApprovalRequest({
      tenantId: TENANT,
      agentId: 'test-agent-3',
      workflowId: 'wf-traj-003',
      taskId: 'task-traj-003',
      hitlLevel: 1,
      pendingToolCalls: [DESTRUCTIVE_CALL],
      reason: 'level_1_gate',
      idempotencyKey: `traj-tamper-${Date.now()}`,
    });

    // Corrupt the stored hash directly via raw pool query
    await pool.query(
      `UPDATE hitl_approval_requests SET tool_calls_hash = 'deadbeefdeadbeef' WHERE id = $1`,
      [approval.id],
    );

    await expect(
      hitlEnforcementService.approveRequest({
        approvalId: approval.id,
        decision: 'approved',
        decidedBy: 'attacker',
        decidedByRole: 'admin',
      }),
    ).rejects.toThrow(/TAMPER_DETECTED|tamper/i);
  });
});

// ── Trajectory 4: Level 1 gates even safe tools ──────────────────────────────

describe('Trajectory: Level 1 gates safe tool call', () => {
  maybe('read_file is gated at level 1 and approval request created', async () => {
    const safeCall: ToolCallRequest = { id: 'tc-safe', name: 'read_file', input: {} };
    const safeTool: ModelTool = { name: 'read_file', description: 'Read a file' };

    const gate = await hitlEnforcementService.checkHitlGate(
      [safeCall],
      OVERSIGHT,
      1,
      [safeTool],
      TENANT,
    );
    expect(gate.shouldGate).toBe(true);
    expect(gate.reason).toBe('level_1_gate');

    const approval = await hitlEnforcementService.createApprovalRequest({
      tenantId: TENANT,
      agentId: 'test-agent-4',
      workflowId: 'wf-traj-004',
      taskId: 'task-traj-004',
      hitlLevel: 1,
      pendingToolCalls: [safeCall],
      reason: 'level_1_gate',
      idempotencyKey: `traj-l1-${Date.now()}`,
    });
    expect(approval.hitlLevel).toBe(1);
    expect(approval.pendingToolCalls[0].name).toBe('read_file');
  });
});
