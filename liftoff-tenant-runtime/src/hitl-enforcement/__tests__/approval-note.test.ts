// Why an approver said yes, kept as memory.
//
// captureCorrection returns early on 'approved' by design — it records what an
// agent must not do again, and an approval is not a correction. But that left
// the learning loop one-sided: an agent learned only from refusals, and a
// standing "always allow" set through alwaysApply carried no record of the
// reasoning behind it. approvalNote is the counterpart to rejectionReason.

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

const captureApprovalNoteMock = jest.fn().mockResolvedValue(undefined);
const captureCorrectionMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../learning/correction-capture', () => ({
  captureApprovalNote: (...a: unknown[]) => captureApprovalNoteMock(...a),
  captureCorrection: (...a: unknown[]) => captureCorrectionMock(...a),
  captureClarificationOutcome: jest.fn().mockResolvedValue(undefined),
}));

import { HitlEnforcementService } from '../service';

const APPROVAL = '00000000-0000-0000-0000-0000000000a1';
const AGENT = '00000000-0000-0000-0000-0000000000a2';
const TENANT = '11111111-1111-1111-1111-111111111111';

function pendingRow(service: HitlEnforcementService) {
  const pendingToolCalls = [{ id: 'tc_1', name: 'sendEmail', input: {} }];
  const hash = (service as unknown as {
    hashToolCalls: (c: unknown[]) => string;
  }).hashToolCalls(pendingToolCalls);
  return {
    id: APPROVAL,
    tenant_id: TENANT,
    workflow_id: null,
    task_id: null,
    agent_id: AGENT,
    hitl_level: 2,
    pending_tool_calls: pendingToolCalls,
    tool_calls_hash: hash,
    reason: 'communication_review',
    status: 'pending',
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('approveRequest — approval note', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    jest.clearAllMocks();
    captureApprovalNoteMock.mockResolvedValue(undefined);
    service = new HitlEnforcementService();
  });

  it('keeps the note as memory when the approver wrote one', async () => {
    queryMock.mockResolvedValue({ rows: [pendingRow(service)], rowCount: 1 });

    await service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
      approvalNote: 'Vendor already vetted',
    } as never);

    expect(captureApprovalNoteMock).toHaveBeenCalledWith(
      TENANT,
      AGENT,
      expect.arrayContaining([expect.objectContaining({ name: 'sendEmail' })]),
      'Vendor already vetted',
    );
  });

  it('writes nothing when the approval was silent', async () => {
    // Most approvals will be. An empty memory entry would be retrieved and
    // injected like any other, so "no note" has to mean no row.
    queryMock.mockResolvedValue({ rows: [pendingRow(service)], rowCount: 1 });

    await service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
    } as never);

    expect(captureApprovalNoteMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only note as silence', async () => {
    queryMock.mockResolvedValue({ rows: [pendingRow(service)], rowCount: 1 });

    await service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
      approvalNote: '   \n  ',
    } as never);

    expect(captureApprovalNoteMock).not.toHaveBeenCalled();
  });

  it('does not let a broken learning module fail a decision already recorded', async () => {
    // The row is written and the run is already moving by this point. Throwing
    // here would hand the caller an error for work that actually succeeded, and
    // a retry would find the approval no longer pending.
    queryMock.mockResolvedValue({ rows: [pendingRow(service)], rowCount: 1 });
    captureApprovalNoteMock.mockRejectedValueOnce(new Error('memory down'));

    await expect(service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
      approvalNote: 'still fine',
    } as never)).resolves.toBeDefined();
  });
});
