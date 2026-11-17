// Shadow-mode trust evaluation tests.
//
// The runtime HITL gate consults the governance trust ledger and LOGS what it
// WOULD do (tier === 'auto' → "would clear"), WITHOUT ever changing the gate
// decision. These tests pin: (1) the log/metric fires only for eligible
// (non-contract-sensitive) gate reasons when tier==='auto'; (2) it never fires
// for super_destructive / merge_to_main, when the flag is off, or in dryRun;
// (3) the returned GateResult is byte-for-byte identical with and without the
// shadow path; (4) a lookup that throws / times out / returns null neither
// changes the result nor throws.

import type { ModelTool, OversightSettings, ToolCallRequest } from '../types';
import { SUPER_DESTRUCTIVE_OPERATIONS } from '../types';

jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [{ count: '0' }] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (_t: string, fn: (_c: { query: typeof sharedQuery }) => Promise<unknown>) => fn({ query: sharedQuery })),
  };
});
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
// Extend the governance-client mock so the shadow lookup (getAgentActionTrust)
// is injectable alongside the existing approval-policy mock.
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));

import { HitlEnforcementService } from '../service';
import { log } from '../../infrastructure/logging';
import { getGovernanceApprovalPolicy, getAgentActionTrust } from '../../governance/governance-service-client';

const mockPolicy = getGovernanceApprovalPolicy as jest.Mock;
const mockTrust = getAgentActionTrust as jest.Mock;

// Flush the fire-and-forget shadow promise chain (getAgentActionTrust → log).
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const TENANT = 'tenant-123';
const AGENT = 'agent-abc';

// Oversight that gates gmail__send via the sensitive_work path (level 3).
const sensitiveOversight: OversightSettings = {
  tenantId: TENANT,
  autonomy: 'balanced',
  escalation: 'sensitive',
  communication: 'review',
  sensitiveWork: {
    customerCommunication: true,
    financialActions: true,
    dataChanges: true,
    externalPublishing: true,
    hiringDecisions: true,
  },
};
const tools: ModelTool[] = [
  { name: 'gmail__send', description: 'Send an email', categories: ['customerCommunication'] },
];
const sensitiveCall: ToolCallRequest[] = [{ id: 't1', name: 'gmail__send', input: {} }];

describe('checkHitlGate — trust shadow mode', () => {
  let svc: HitlEnforcementService;
  let logSpy: jest.SpyInstance;
  const ORIG_FLAG = process.env.HITL_TRUST_SHADOW_ENABLED;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    mockPolicy.mockResolvedValue(null);
    mockTrust.mockResolvedValue(null);
    logSpy = jest.spyOn(log, 'info').mockImplementation((() => log) as never);
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (ORIG_FLAG === undefined) delete process.env.HITL_TRUST_SHADOW_ENABLED;
    else process.env.HITL_TRUST_SHADOW_ENABLED = ORIG_FLAG;
  });

  function shadowLogCalls(): unknown[] {
    return logSpy.mock.calls.filter(
      (c) => typeof c[0] === 'object' && c[0] !== null && (c[0] as { event?: string }).event === 'hitl_trust_shadow_would_clear',
    );
  }

  it('emits the shadow log when an eligible gate fires AND tier === "auto"', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
    await flush();

    // Decision unchanged.
    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    // Lookup keyed on the normalized (bare) action name.
    expect(mockTrust).toHaveBeenCalledWith(TENANT, AGENT, 'send');
    const calls = shadowLogCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      event: 'hitl_trust_shadow_would_clear',
      tenantId: TENANT,
      agentId: AGENT,
      actionClass: 'send',
      gateReason: 'sensitive_work',
      runs: 42,
      passRate: 0.97,
    });
  });

  it('emits for level_1_gate too (also an eligible reason)', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 10, passRate: 1 });

    const result = await svc.checkHitlGate(
      [{ id: 't1', name: 'github-x__get_issue', input: {} }],
      { ...sensitiveOversight, escalation: 'exceptions' },
      1,
      [{ name: 'github-x__get_issue', description: 'read', categories: [] }],
      TENANT,
      AGENT,
    );
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'level_1_gate' });
    expect(mockTrust).toHaveBeenCalledWith(TENANT, AGENT, 'get_issue');
    expect(shadowLogCalls()).toHaveLength(1);
  });

  it('does NOT emit when tier is not "auto"', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    for (const tier of ['watch', 'queue']) {
      logSpy.mockClear();
      mockTrust.mockResolvedValue({ tier, runs: 5, passRate: 0.5 });
      await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
      await flush();
      expect(shadowLogCalls()).toHaveLength(0);
    }
  });

  it('does NOT emit when the flag is off (default)', async () => {
    delete process.env.HITL_TRUST_SHADOW_ENABLED;
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(mockTrust).not.toHaveBeenCalled();
    expect(shadowLogCalls()).toHaveLength(0);
  });

  it('does NOT emit in dryRun', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT, { dryRun: true });
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(mockTrust).not.toHaveBeenCalled();
    expect(shadowLogCalls()).toHaveLength(0);
  });

  it('does NOT emit (or even look up) for super_destructive_gate', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const opName = [...SUPER_DESTRUCTIVE_OPERATIONS][0];
    const result = await svc.checkHitlGate(
      [{ id: 't1', name: opName, input: {} }],
      sensitiveOversight,
      5,
      [{ name: opName, description: `⚠️ DESTRUCTIVE: ${opName}` }],
      TENANT,
      AGENT,
    );
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'super_destructive_gate' });
    expect(mockTrust).not.toHaveBeenCalled();
    expect(shadowLogCalls()).toHaveLength(0);
  });

  it('does NOT emit (or even look up) for merge_to_main', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const mergeOversight: OversightSettings = {
      ...sensitiveOversight,
      sensitiveWork: { ...sensitiveOversight.sensitiveWork, mergeToMain: true },
    };
    const result = await svc.checkHitlGate(
      [{ id: 't1', name: 'github-x__merge_pull_request', input: {} }],
      mergeOversight,
      5,
      [],
      TENANT,
      AGENT,
    );
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'merge_to_main' });
    expect(mockTrust).not.toHaveBeenCalled();
    expect(shadowLogCalls()).toHaveLength(0);
  });

  it('does NOT emit when agentId is absent (same guard as policy lookup)', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT /* no agentId */);
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(mockTrust).not.toHaveBeenCalled();
    expect(shadowLogCalls()).toHaveLength(0);
  });

  // ── GateResult is byte-for-byte identical with and without the shadow path ──

  it('returns an IDENTICAL GateResult with shadow enabled+auto vs. shadow disabled (sensitive_work)', async () => {
    // Shadow OFF baseline.
    delete process.env.HITL_TRUST_SHADOW_ENABLED;
    const baseline = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);

    // Shadow ON + tier auto (the case that emits).
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue({ tier: 'auto', runs: 42, passRate: 0.97 });
    const withShadow = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
    await flush();

    expect(withShadow).toEqual(baseline);
    expect(baseline).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
  });

  it('a lookup that throws does not change the gate result and does not throw', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockRejectedValue(new Error('governance-engine unreachable'));

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(shadowLogCalls()).toHaveLength(0);
  });

  it('a lookup that returns null does not emit and does not change the result', async () => {
    process.env.HITL_TRUST_SHADOW_ENABLED = 'true';
    mockTrust.mockResolvedValue(null);

    const result = await svc.checkHitlGate(sensitiveCall, sensitiveOversight, 3, tools, TENANT, AGENT);
    await flush();

    expect(result).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(shadowLogCalls()).toHaveLength(0);
  });
});
