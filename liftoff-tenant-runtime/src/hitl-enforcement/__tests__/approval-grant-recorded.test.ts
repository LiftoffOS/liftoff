// A yes records what it covered.
//
// The approval row already fingerprinted the calls as PROPOSED. The reviewer's
// edits are applied after that check and stored beside it, so the calls that
// actually run were never fingerprinted — and nothing recorded which reasons
// the person's yes was about. Both are written with the yes now: the
// fingerprint of the post-edit calls, and the reasons in force for them under
// the settings at that moment, with the evaluator version that computed them.

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
  getPoolForService: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
  withTenantScope: async (
    _t: string,
    fn: (c: { query: (...a: unknown[]) => unknown }) => Promise<unknown>,
  ) => fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
const policyMock = jest.fn().mockResolvedValue(null);
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: (...a: unknown[]) => policyMock(...a),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../platform-callback/client', () => ({ postSkillFeedback: jest.fn() }));
const stagedRepoMock = {
  findForApply: jest.fn(),
  bindApproval: jest.fn(),
  cancelById: jest.fn(),
};
jest.mock('../../tool-gateway/staged-batches', () => ({
  stagedBatchRepository: () => stagedRepoMock,
  stagedApplyReasons: jest.requireActual('../../tool-gateway/staged-batches').stagedApplyReasons,
  stripProtocolArgs: jest.requireActual('../../tool-gateway/staged-batches').stripProtocolArgs,
}));
const fetchOversightMock = jest.fn();
jest.mock('../../clients/platform-backend-client', () => ({ fetchOversightSettings: (...a: unknown[]) => fetchOversightMock(...a) }));

import { HitlEnforcementService } from '../service';
import { OBLIGATION_EVALUATOR_VERSION } from '../approval-obligations';

const APPROVAL = '00000000-0000-0000-0000-0000000000a1';
const TENANT = '00000000-0000-0000-0000-000000000011';
const AGENT = '00000000-0000-0000-0000-0000000000a2';

const PENDING = [{ id: 'pc1', name: 'crm__delete_contact', input: { id: 'contact-7' } }];

function pendingRow(service: HitlEnforcementService, over: Record<string, unknown> = {}) {
  const hash = (service as unknown as { hashToolCalls: (c: unknown[]) => string }).hashToolCalls(PENDING);
  return {
    id: APPROVAL, tenant_id: TENANT, workflow_id: null, task_id: null, agent_id: AGENT,
    hitl_level: 2, pending_tool_calls: PENDING, tool_calls_hash: hash, reason: 'destructive_gate',
    status: 'pending', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date(),
    gate_view: { tools: [{ name: 'crm__delete_contact', description: '⚠️ DESTRUCTIVE', effect: 'write', categories: ['dataChanges'] }] },
    ...over,
  };
}

function routePool(row: Record<string, unknown>, oversight: Record<string, unknown>, hire: { hitl_level: number } | Error = { hitl_level: 2 }) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/tenant_oversight_cache/.test(sql)) return { rows: [oversight], rowCount: 1 };
    if (/FROM agents/.test(sql)) {
      if (hire instanceof Error) throw hire;
      return { rows: [hire], rowCount: 1 };
    }
    return { rows: [row], rowCount: 1 };
  });
}

const OVERSIGHT_ROW = {
  tenant_id: TENANT, autonomy: 'controlled', escalation: 'sensitive',
  sensitive_work: { dataChanges: true }, communication: 'auto',
};

function approveUpdate(): { sql: string; params: unknown[] } {
  const call = queryMock.mock.calls.find((c) => /UPDATE hitl_approval_requests/.test(String(c[0])) && /'approved'/.test(String(c[0])));
  return { sql: String(call![0]), params: call![1] as unknown[] };
}

describe('the yes records the grant', () => {
  let service: HitlEnforcementService;
  beforeEach(() => {
    jest.clearAllMocks();
    policyMock.mockResolvedValue(null);
    service = new HitlEnforcementService();
  });

  it('writes the fingerprint of the calls that will run, the granted set and the evaluator version', async () => {
    routePool(pendingRow(service), OVERSIGHT_ROW);
    await service.approveRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin' } as never);

    const { sql, params } = approveUpdate();
    expect(sql).toMatch(/final_tool_calls_hash = \$5/);
    expect(sql).toMatch(/granted_obligations = \$6::jsonb/);
    expect(sql).toMatch(/obligations_evaluator_version = \$7/);
    // No edits: the final fingerprint IS the proposal fingerprint.
    expect(params[4]).toBe((service as unknown as { hashToolCalls: (c: unknown[]) => string }).hashToolCalls(PENDING));
    // Destructive at level 2 AND sensitive (dataChanges on) — both covered.
    expect(JSON.parse(params[5] as string)).toEqual(['destructive_gate', 'sensitive_work']);
    expect(params[6]).toBe(OBLIGATION_EVALUATOR_VERSION);
  });

  it('fingerprints the EDITED calls, not the proposed ones', async () => {
    routePool(pendingRow(service), OVERSIGHT_ROW);
    await service.approveRequest({
      approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin',
      editedToolInputs: { pc1: { id: 'contact-8' } },
    } as never);
    const { params } = approveUpdate();
    const hash = (service as unknown as { hashToolCalls: (c: unknown[]) => string }).hashToolCalls;
    expect(params[4]).toBe(hash([{ id: 'pc1', name: 'crm__delete_contact', input: { id: 'contact-8' } }]));
    expect(params[4]).not.toBe(hash(PENDING));
  });

  it('always covers the reason the person was shown, whatever the recompute says', async () => {
    // A row from before the gate view existed: the evaluator has no tools to
    // classify and finds nothing — but the person said yes to destructive_gate.
    routePool(pendingRow(service, { gate_view: null }), { ...OVERSIGHT_ROW, sensitive_work: {} });
    await service.approveRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin' } as never);
    const { params } = approveUpdate();
    expect(JSON.parse(params[5] as string)).toEqual(['destructive_gate']);
  });

  it('a standing approval clears a reason from the grant, so a later revocation re-asks', async () => {
    policyMock.mockImplementation(async (_t: string, _a: string, reason: string) =>
      reason === 'sensitive_work' ? { decision: 'approved' } : null);
    routePool(pendingRow(service), OVERSIGHT_ROW);
    await service.approveRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin' } as never);
    const { params } = approveUpdate();
    // sensitive_work was cleared by the standing policy and is not in force,
    // so the yes did not cover it; revoke the policy and the resume asks.
    expect(JSON.parse(params[5] as string)).toEqual(['destructive_gate']);
  });

  it('reads the grant back off the row', async () => {
    const row = pendingRow(service, {
      final_tool_calls_hash: 'fp', granted_obligations: ['destructive_gate'], obligations_evaluator_version: OBLIGATION_EVALUATOR_VERSION,
    });
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });
    const approval = await service.getApprovalRequest(APPROVAL);
    expect(approval?.finalToolCallsHash).toBe('fp');
    expect(approval?.grantedObligations).toEqual(['destructive_gate']);
    expect(approval?.obligationsEvaluatorVersion).toBe(OBLIGATION_EVALUATOR_VERSION);
    expect(approval?.gateView?.tools[0].name).toBe('crm__delete_contact');
  });

  // Two callers, two failure conventions. Recording the grant follows the
  // gate: a read that fails is fail-open, the reason stays in force, the yes
  // covers it. Recomputing at CONSUMPTION cannot: a set computed over defaults
  // or over "no policy" is not the set in force, and consuming a grant against
  // it either dispatches under unknown settings or re-asks about a control
  // nobody tightened. Strict turns that read failure into a throw, which the
  // consumption point answers with a deferral.
  describe('reads at consumption are strict', () => {
    it('a standing-policy read that fails is fail-open when recording, and a throw when strict', async () => {
      policyMock.mockRejectedValue(new Error('governance engine 503'));
      routePool(pendingRow(service), OVERSIGHT_ROW);
      const approval = (await service.getApprovalRequest(APPROVAL))!;
      const lenient = await service.obligationConfigFor(approval);
      expect(lenient.standingPolicies).toEqual({});
      await expect(service.obligationConfigFor(approval, { strict: true }))
        .rejects.toThrow(/standing policy .* unreadable: governance engine 503/);
    });

    it('an oversight read that fails falls to defaults when recording, and throws when strict', async () => {
      // Cache miss, and the fetch fails.
      queryMock.mockImplementation(async (sql: string) => {
        if (/tenant_oversight_cache/.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [pendingRow(service)], rowCount: 1 };
      });
      fetchOversightMock.mockRejectedValue(new Error('platform-backend 502'));
      const approval = (await service.getApprovalRequest(APPROVAL))!;
      const lenient = await service.obligationConfigFor(approval);
      // The gate's fail-closed defaults, not the tenant's settings.
      expect(lenient.oversight?.communication).toBe('review');
      await expect(service.obligationConfigFor(approval, { strict: true }))
        .rejects.toThrow(/platform-backend 502/);
    });

    it('the hire\'s level is read as it is now, not as the row recorded it', async () => {
      policyMock.mockResolvedValue(null);
      // The gate fired at level 2; the hire has since been moved to level 1.
      routePool(pendingRow(service), OVERSIGHT_ROW, { hitl_level: 1 });
      const approval = (await service.getApprovalRequest(APPROVAL))!;
      expect(approval.hitlLevel).toBe(2);
      expect((await service.obligationConfigFor(approval, { strict: true })).hitlLevel).toBe(1);
      expect((await service.obligationConfigFor(approval)).hitlLevel).toBe(1);
    });

    it('a level read that fails falls back to the recorded level when recording, and throws when strict', async () => {
      policyMock.mockResolvedValue(null);
      routePool(pendingRow(service), OVERSIGHT_ROW, new Error('agents unreadable'));
      const approval = (await service.getApprovalRequest(APPROVAL))!;
      expect((await service.obligationConfigFor(approval)).hitlLevel).toBe(2);
      await expect(service.obligationConfigFor(approval, { strict: true }))
        .rejects.toThrow(/hire level unreadable: agents unreadable/);
    });

    it('strict reads the same settings as lenient when every read succeeds', async () => {
      policyMock.mockResolvedValue(null);
      routePool(pendingRow(service), OVERSIGHT_ROW);
      const approval = (await service.getApprovalRequest(APPROVAL))!;
      const strict = await service.obligationConfigFor(approval, { strict: true });
      expect(strict.oversight?.escalation).toBe('sensitive');
      expect(strict.tools[0].name).toBe('crm__delete_contact');
    });
  });

  // The stage/apply protocol's approval half (ADR-052 rule 5, clauses 4, 5
  // and 6): a yes on the apply binds the staged batch to the approval against
  // its digest as staged; a no cancels it. Host-written on both rows.
  describe('a staged batch follows the decision on its apply', () => {
    const APPLY_PENDING = [{ id: 'pc1', name: 'mailchimp-1a2b3c4d__send_campaign', input: { campaign_id: 'cmp_881' } }];
    const APPLY_VIEW = { tools: [{ name: 'mailchimp-1a2b3c4d__send_campaign', effect: 'write', categories: ['write', 'outbound'], writeRole: 'apply' }] };
    const BATCH = { id: 'batch-1', digest: 'd1', status: 'staged' };

    beforeEach(() => {
      stagedRepoMock.findForApply.mockReset().mockResolvedValue(BATCH);
      stagedRepoMock.bindApproval.mockReset().mockResolvedValue({ ...BATCH, status: 'approved', approvalId: APPROVAL, approvedDigest: 'd1' });
      stagedRepoMock.cancelById.mockReset().mockResolvedValue(true);
    });

    it('a yes binds the batch the apply names, within its binding, before the approval returns', async () => {
      const hash = (service as unknown as { hashToolCalls: (c: unknown[]) => string }).hashToolCalls(APPLY_PENDING);
      routePool(pendingRow(service, { pending_tool_calls: APPLY_PENDING, tool_calls_hash: hash, reason: 'blast_radius', gate_view: APPLY_VIEW }), OVERSIGHT_ROW);
      await service.approveRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin' } as never);
      expect(stagedRepoMock.findForApply).toHaveBeenCalledWith({
        tenantId: TENANT, agentId: AGENT, connector: 'mailchimp-1a2b3c4d', applyTool: 'send_campaign', applyArgs: { campaign_id: 'cmp_881' },
      });
      expect(stagedRepoMock.bindApproval).toHaveBeenCalledWith(TENANT, 'batch-1', APPROVAL, expect.any(Date));
      expect(stagedRepoMock.cancelById).not.toHaveBeenCalled();
    });

    it('a no cancels the batch, and nothing is bound', async () => {
      const hash = (service as unknown as { hashToolCalls: (c: unknown[]) => string }).hashToolCalls(APPLY_PENDING);
      routePool(pendingRow(service, { pending_tool_calls: APPLY_PENDING, tool_calls_hash: hash, reason: 'blast_radius', gate_view: APPLY_VIEW }), OVERSIGHT_ROW);
      await service.rejectRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin', rejectionReason: 'not this list' } as never);
      expect(stagedRepoMock.cancelById).toHaveBeenCalledWith(TENANT, 'batch-1', expect.stringContaining(APPROVAL));
      expect(stagedRepoMock.bindApproval).not.toHaveBeenCalled();
    });

    it('a call that is not an apply binds and cancels nothing', async () => {
      routePool(pendingRow(service), OVERSIGHT_ROW);
      await service.approveRequest({ approvalId: APPROVAL, decidedBy: 'ada', decidedByRole: 'admin' } as never);
      expect(stagedRepoMock.findForApply).not.toHaveBeenCalled();
    });
  });
});
