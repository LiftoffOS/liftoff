// Increment B — server-side execution of approved/rejected sandbox-code calls,
// and the stale-approval expiry sweep.

const calls: Array<{ sql: string; params: unknown[] }> = [];
const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  if (sql.includes('compiled_instructions')) return { rows: [{ integrations: [] }] };
  if (sql.includes('UPDATE hitl_approval_requests')) return { rows: [{ idempotency_key: 'idem-1', tenant_id: 'T' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../tool-gateway/binding-resolver', () => ({ buildBindingsByType: () => ({}) }));
jest.mock('../../instruction-compiler/integration-shape', () => ({ normalizeIntegrationsField: (v: unknown) => v ?? [] }));
const mockExecuteConnectorCall = jest.fn();
jest.mock('../../tool-gateway/router', () => ({ toolGatewayService: { executeConnectorCall: mockExecuteConnectorCall } }));

import { executeSandboxApprovedCall, rejectSandboxApprovedCall, expireStaleSandboxApprovals } from '../sandbox-approval-executor';
import type { HitlApprovalRequest } from '../../hitl-enforcement/types';

function approval(): HitlApprovalRequest {
  return {
    id: 'appr-1', tenantId: 'T', agentId: 'A', idempotencyKey: 'idem-1',
    pendingToolCalls: [{ id: 'idem-1', name: 'gmail__send_email', input: { to: 'x' } }],
    source: 'sandbox_code',
  } as unknown as HitlApprovalRequest;
}
function actionsUpdate() {
  return calls.find(c => c.sql.includes('UPDATE actions'));
}

beforeEach(() => { calls.length = 0; jest.clearAllMocks(); mockQuery.mockClear(); });

describe('sandbox approval executor', () => {
  it('approve: executes the connector and settles the action completed with the result', async () => {
    mockExecuteConnectorCall.mockResolvedValue({ success: true, data: { sent: true } });
    await executeSandboxApprovedCall(approval());
    expect(mockExecuteConnectorCall).toHaveBeenCalledWith(expect.objectContaining({ connector: 'gmail', actionType: 'gmail__send_email', idempotencyKey: 'idem-1' }));
    const upd = actionsUpdate();
    expect(upd).toBeTruthy();
    expect(upd!.params[0]).toBe('completed');
    expect(upd!.params[1]).toBe(JSON.stringify({ sent: true }));
    expect(upd!.params[2]).toBe('idem-1');
  });

  it('approve: connector failure still settles completed with the error payload (script gets the result)', async () => {
    mockExecuteConnectorCall.mockResolvedValue({ success: false, error: 'boom' });
    await executeSandboxApprovedCall(approval());
    const upd = actionsUpdate();
    expect(upd!.params[0]).toBe('completed');
    expect(upd!.params[1]).toBe(JSON.stringify({ success: false, error: 'boom' }));
  });

  it('reject: settles the action rejected with the reason, never executes the connector', async () => {
    await rejectSandboxApprovedCall(approval(), 'not allowed');
    expect(mockExecuteConnectorCall).not.toHaveBeenCalled();
    const upd = actionsUpdate();
    expect(upd!.params[0]).toBe('rejected');
    expect(upd!.params[1]).toBe(JSON.stringify({ reason: 'not allowed' }));
  });

  it('expiry sweep: flips stale pending approvals to expired and settles their actions', async () => {
    const n = await expireStaleSandboxApprovals();
    expect(n).toBe(1);
    expect(calls.some(c => c.sql.includes("UPDATE hitl_approval_requests") && c.sql.includes("'expired'"))).toBe(true);
    expect(calls.some(c => c.sql.includes('UPDATE actions'))).toBe(true);
  });
});
