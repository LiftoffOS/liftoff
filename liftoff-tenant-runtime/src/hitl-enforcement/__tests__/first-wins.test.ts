// A pending approval is now visible to the assignees, to every admin and owner,
// and on three surfaces at once (chat, review queue, Slack/Teams cards). Two
// people deciding at the same moment stopped being hypothetical, so the
// decision has to be first-wins rather than last-write-wins.
//
// The old shape read the row, checked `status === 'pending'`, then issued
// `UPDATE ... WHERE id = $1`. Both racers passed the check and both wrote: an
// approve landing after a reject flipped a refused action to approved and
// resumed its tool calls.

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
  withTenantScope: async (
    _t: string,
    fn: (c: { query: (...a: unknown[]) => unknown }) => Promise<unknown>,
  ) => fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HitlEnforcementService } from '../service';

const APPROVAL = '00000000-0000-0000-0000-0000000000a1';
const TENANT = '00000000-0000-0000-0000-0000000000t1'.replace(/t/g, '1');

/** A row the pre-checks accept: pending, unexpired, hash matching. */
function pendingRow(service: HitlEnforcementService) {
  const pendingToolCalls: unknown[] = [];
  const hash = (service as unknown as {
    hashToolCalls: (c: unknown[]) => string;
  }).hashToolCalls(pendingToolCalls);
  return {
    id: APPROVAL,
    tenant_id: TENANT,
    workflow_id: null,
    task_id: null,
    agent_id: '00000000-0000-0000-0000-0000000000a2',
    hitl_level: 2,
    pending_tool_calls: pendingToolCalls,
    tool_calls_hash: hash,
    reason: 'because',
    status: 'pending',
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('hitl first-wins decisions', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HitlEnforcementService();
  });

  it('scopes the approve UPDATE to a still-pending row', async () => {
    const row = pendingRow(service);
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });

    await service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
    } as never);

    const update = queryMock.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => /UPDATE hitl_approval_requests/.test(sql) && /approved/.test(sql));
    expect(update).toMatch(/WHERE id = \$1 AND status = 'pending'/);
  });

  it('scopes the reject UPDATE the same way', async () => {
    const row = pendingRow(service);
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });

    await service.rejectRequest({
      approvalId: APPROVAL, decidedBy: 'bob', decidedByRole: 'admin', rejectionReason: 'no',
    } as never);

    const update = queryMock.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => /UPDATE hitl_approval_requests/.test(sql) && /rejected/.test(sql));
    expect(update).toMatch(/WHERE id = \$1 AND status = 'pending'/);
  });

  // The race: both callers read a pending row, so both clear the pre-check.
  // The loser's UPDATE matches nothing, and it must be told rather than
  // silently believing it decided.
  it('tells the loser of a race that it was already decided', async () => {
    const row = pendingRow(service);
    queryMock.mockImplementation((sql: string) => {
      if (/UPDATE hitl_approval_requests/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT status FROM hitl_approval_requests/.test(sql)) {
        return { rows: [{ status: 'rejected' }], rowCount: 1 };
      }
      return { rows: [row], rowCount: 1 };
    });

    await expect(
      service.approveRequest({
        approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
      } as never),
    // Wording preserved so the existing error mapping still yields
    // 409 ALREADY_DECIDED rather than a 500.
    ).rejects.toThrow(/request status is rejected/);
  });

  it('does not record a trust decision for the losing caller', async () => {
    const row = pendingRow(service);
    queryMock.mockImplementation((sql: string) => {
      if (/UPDATE hitl_approval_requests/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT status FROM hitl_approval_requests/.test(sql)) {
        return { rows: [{ status: 'approved' }], rowCount: 1 };
      }
      return { rows: [row], rowCount: 1 };
    });

    await expect(
      service.rejectRequest({
        approvalId: APPROVAL, decidedBy: 'bob', decidedByRole: 'admin',
      } as never),
    ).rejects.toThrow(/already|status is/i);

    const trustWrites = queryMock.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => /trust/i.test(sql) && /INSERT/i.test(sql));
    expect(trustWrites).toHaveLength(0);
  });
});
