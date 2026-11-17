// The Escalation setting, given the meaning the oversight page states
// (surfacing.ts): the table per setting; the policy is in force only once the
// workspace saved the setting under the new meaning and the kill is on; a
// question under "Only exceptions" still parks and writes its row with no
// notification; hard invariants reach the page under every setting; and
// "Important decisions" no longer gates sensitive work, pinned as an intended
// change with the page's copy.

jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [{ count: '0' }] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (_t: string, fn: (c: { query: typeof sharedQuery }) => Promise<unknown>) => fn({ query: sharedQuery })),
  };
});
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../typesafe/client', () => ({ ask: jest.fn().mockResolvedValue(null) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { surfacingPolicyFor, surfacingPolicyInForce, surfacingPolicyOf } from '../surfacing';
import { HitlEnforcementService } from '../service';
import { evaluateApprovalObligations } from '../approval-obligations';
import { semanticsOf, type ModelTool, type OversightSettings, type ToolCallRequest } from '../types';

const tools: ModelTool[] = [
  { name: 'crm__update_contact', description: 'Update a contact', categories: ['dataChanges'], effect: 'write' },
];
const write: ToolCallRequest = { id: 'w1', name: 'crm__update_contact', input: { id: 'c1' } };
const oversight = (escalation: OversightSettings['escalation'], escalationSemantics?: number): OversightSettings => ({
  tenantId: 't1', autonomy: 'balanced', escalation, sensitiveWork: { dataChanges: true }, communication: 'auto',
  ...(escalationSemantics !== undefined ? { escalationSemantics } : {}),
});

beforeEach(() => {
  delete process.env.TR_SURFACING_POLICY_ENABLED;
});

describe('the table', () => {
  it('exceptions: blockers, contract deviations and hard invariants only', () => {
    expect(surfacingPolicyFor('exceptions')).toEqual({ sensitiveWorkGates: false, asksAndEscalations: false });
  });
  it('important: the above plus questions and escalations that pass the ask check', () => {
    expect(surfacingPolicyFor('important')).toEqual({ sensitiveWorkGates: false, asksAndEscalations: true });
  });
  it('sensitive: the above plus the opted-in sensitive-work gates, as today', () => {
    expect(surfacingPolicyFor('sensitive')).toEqual({ sensitiveWorkGates: true, asksAndEscalations: true });
  });
});

describe('when the policy is in force', () => {
  it('only at escalationSemantics >= 2 with the kill on; absent reads as 1', () => {
    expect(surfacingPolicyInForce(oversight('important'))).toBe(false);
    expect(surfacingPolicyInForce(oversight('important', 1))).toBe(false);
    expect(surfacingPolicyInForce(oversight('important', 2))).toBe(true);
    expect(surfacingPolicyInForce(undefined)).toBe(false);
    process.env.TR_SURFACING_POLICY_ENABLED = '0';
    expect(surfacingPolicyInForce(oversight('important', 2))).toBe(false);
    expect(surfacingPolicyOf(oversight('important', 2))).toBeNull();
  });

  it('semanticsOf: an integer 1 or above, else 1', () => {
    expect(semanticsOf(2)).toBe(2);
    expect(semanticsOf('2')).toBe(2);
    expect(semanticsOf(undefined)).toBe(1);
    expect(semanticsOf(null)).toBe(1);
    expect(semanticsOf('x')).toBe(1);
    expect(semanticsOf(0)).toBe(1);
    expect(semanticsOf(1.5)).toBe(1);
  });
});

describe('section 5 of the gate reads the setting through the policy', () => {
  const service = new HitlEnforcementService();

  it('a workspace at escalationSemantics = 1 with "important" still gates sensitive work (today\'s reading)', async () => {
    const r = await service.checkHitlGate([write], oversight('important', 1), 3, tools, 't1', 'a1');
    expect(r).toEqual({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'dataChanges' });
    expect(evaluateApprovalObligations([write], { hitlLevel: 3, oversight: oversight('important', 1), tools, standingPolicies: {} }).reasons).toEqual(['sensitive_work']);
  });

  it('"important" no longer gates sensitive work once the workspace saved it under the stated meaning', async () => {
    // The page copy: "Sensitive or high-impact work" is the third level, and
    // "Important decisions" is the second. The code follows the page: this
    // is the one part of the change that loosens a gate, by the user's own
    // setting and never by a model verdict.
    const r = await service.checkHitlGate([write], oversight('important', 2), 3, tools, 't1', 'a1');
    expect(r).toEqual({ shouldGate: false });
    expect(evaluateApprovalObligations([write], { hitlLevel: 3, oversight: oversight('important', 2), tools, standingPolicies: {} }).reasons).toEqual([]);
  });

  it('"sensitive" gates the opted-in categories under both meanings', async () => {
    for (const sem of [1, 2]) {
      const r = await service.checkHitlGate([write], oversight('sensitive', sem), 3, tools, 't1', 'a1');
      expect(r).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
    }
  });

  it('"exceptions" gates none under either meaning', async () => {
    for (const sem of [1, 2]) {
      expect(await service.checkHitlGate([write], oversight('exceptions', sem), 3, tools, 't1', 'a1')).toEqual({ shouldGate: false });
    }
  });

  it('the kill restores today\'s single reader', async () => {
    process.env.TR_SURFACING_POLICY_ENABLED = '0';
    const r = await service.checkHitlGate([write], oversight('important', 2), 3, tools, 't1', 'a1');
    expect(r).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
  });

  it('hard invariants reach the page under every setting', async () => {
    for (const setting of ['exceptions', 'important', 'sensitive'] as const) {
      const r = await service.checkHitlGate([{ id: 'd', name: 'delete_tenant', input: {} }], oversight(setting, 2), 5, tools, 't1', 'a1');
      expect(r).toEqual({ shouldGate: true, reason: 'super_destructive_gate' });
      const m = await service.checkHitlGate([{ id: 'm', name: 'merge_pull_request', input: {} }], oversight(setting, 2), 5, tools, 't1', 'a1');
      expect(m).toEqual({ shouldGate: true, reason: 'merge_to_main' });
      const e = await service.checkHitlGate([write], oversight(setting, 2), 5, tools, 't1', 'a1', { trustLevel: 'untrusted_inbound' });
      expect(e).toEqual({ shouldGate: true, reason: 'external_content_write' });
    }
  });
});
