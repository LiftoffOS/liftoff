// The external_content_write invariant: a write/spawn tool call in an
// untrusted_inbound run gates, before the level-4/5 autonomy shortcuts, cleared
// only by a standing policy whose action_classes cover every pending call. Reads
// pass; the operator kill-switch bypasses; a policy-lookup failure fails closed.

import type { ModelTool, OversightSettings, ToolCallRequest } from '../types';

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
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../clients/platform-backend-client', () => ({ fetchOversightSettings: jest.fn() }));

import { HitlEnforcementService } from '../service';
import { getGovernanceApprovalPolicy } from '../../governance/governance-service-client';

const mockPolicy = getGovernanceApprovalPolicy as jest.Mock;

const oversight: OversightSettings = {
  tenantId: 't1', autonomy: 'balanced', escalation: 'important', communication: 'review',
  sensitiveWork: {} as OversightSettings['sensitiveWork'],
} as OversightSettings;

const writeTool: ModelTool = { name: 'post_tweet', description: 'Post', categories: [], effect: 'write' };
const readTool: ModelTool = { name: 'get_feed', description: 'Read', categories: [], effect: 'read' };
const spawnTool: ModelTool = { name: 'delegate_to_agent', description: 'Delegate', categories: [], effect: 'spawn' };
const unclassifiedTool: ModelTool = { name: 'mystery_op', description: 'Mystery', categories: [] };

function call(name: string): ToolCallRequest {
  return { id: '1', name, input: {} } as unknown as ToolCallRequest;
}

describe('checkHitlGate — external_content_write invariant', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  const untrusted = { trustLevel: 'untrusted_inbound' as const };

  it('trusted run with a write tool does not gate on this reason', async () => {
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', { trustLevel: 'trusted' });
    expect(res.shouldGate).toBe(false);
  });

  it('untrusted + read tool passes ungated', async () => {
    const res = await svc.checkHitlGate([call('get_feed')], oversight, 3, [readTool], 't1', 'a1', untrusted);
    expect(res.shouldGate).toBe(false);
  });

  it('untrusted + write gates as external_content_write', async () => {
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', untrusted);
    expect(res).toEqual({ shouldGate: true, reason: 'external_content_write' });
  });

  it('untrusted + spawn gates', async () => {
    const res = await svc.checkHitlGate([call('delegate_to_agent')], oversight, 3, [spawnTool], 't1', 'a1', untrusted);
    expect(res.reason).toBe('external_content_write');
  });

  it('untrusted + missing effect gates (fail closed)', async () => {
    const res = await svc.checkHitlGate([call('mystery_op')], oversight, 3, [unclassifiedTool], 't1', 'a1', untrusted);
    expect(res.reason).toBe('external_content_write');
  });

  it('invariant beats earned autonomy: gates at level 4 AND level 5', async () => {
    for (const level of [4, 5]) {
      const res = await svc.checkHitlGate([call('post_tweet')], oversight, level, [writeTool], 't1', 'a1', untrusted);
      expect(res.reason).toBe('external_content_write');
    }
  });

  it('a class-scoped policy covering every call clears it', async () => {
    mockPolicy.mockResolvedValue({ decision: 'approved', actionClasses: ['post_tweet'] });
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', untrusted);
    expect(res.shouldGate).toBe(false);
  });

  it('a legacy reason-wide policy (actionClasses null) does NOT clear it', async () => {
    mockPolicy.mockResolvedValue({ decision: 'approved', actionClasses: null });
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', untrusted);
    expect(res.reason).toBe('external_content_write');
  });

  it('a policy that does not cover every call does NOT clear it', async () => {
    mockPolicy.mockResolvedValue({ decision: 'approved', actionClasses: ['something_else'] });
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', untrusted);
    expect(res.reason).toBe('external_content_write');
  });

  it('a policy-lookup failure fails closed (gates)', async () => {
    mockPolicy.mockRejectedValue(new Error('governance unreachable'));
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1', untrusted);
    expect(res.reason).toBe('external_content_write');
  });

  it('the operator kill-switch bypasses the gate', async () => {
    const res = await svc.checkHitlGate([call('post_tweet')], oversight, 3, [writeTool], 't1', 'a1',
      { trustLevel: 'untrusted_inbound', externalContentGateDisabled: true });
    expect(res.shouldGate).toBe(false);
  });
});

describe('the standard tools, as each catalog hands them to the gate', () => {
  // Two catalogs reach this gate. The bridge stamped each standard tool's
  // effect; the workflow catalog pushed the raw definitions, which carry
  // none, so `have_i_acted_on` arrived as "unknown", failed closed, and a
  // support hire would ask a person to approve reading its own ledger on
  // every inbound poll.
  // Both catalogs now state the effect through one function; this drives
  // the gate with a standard tool shaped exactly as that function shapes it.
  const { standardToolEffect } = jest.requireActual('../../tool-gateway/tool-effect') as {
    standardToolEffect: (name: string) => 'read' | 'write' | 'spawn';
  };
  const asCatalogued = (name: string): ModelTool => ({
    name, description: name, categories: [], effect: standardToolEffect(name),
  });
  const untrusted = { trustLevel: 'untrusted_inbound' as const };

  it.each(['have_i_acted_on', 'memory_retrieve', 'corpus_search'])(
    '%s on an untrusted-inbound run passes ungated', async (name) => {
      const svc = new HitlEnforcementService();
      mockPolicy.mockResolvedValue(null);
      const res = await svc.checkHitlGate([call(name)], oversight, 3, [asCatalogued(name)], 't1', 'a1', untrusted);
      expect(res).toEqual({ shouldGate: false });
    },
  );

  it('have_i_acted_on shaped the old way — no effect, no categories — is what gated', async () => {
    // The name holds no verb the fallback classifier knows, so nothing but a
    // stated effect can say it is a read. This is the defect, kept as a test
    // so the shape that produced it stays recognisable.
    const svc = new HitlEnforcementService();
    mockPolicy.mockResolvedValue(null);
    const bare: ModelTool = { name: 'have_i_acted_on', description: 'Own ledger', categories: [] };
    const res = await svc.checkHitlGate([call('have_i_acted_on')], oversight, 3, [bare], 't1', 'a1', untrusted);
    expect(res).toEqual({ shouldGate: true, reason: 'external_content_write' });
  });

  it('audit_log never gates, whatever the catalog says about it', async () => {
    const svc = new HitlEnforcementService();
    mockPolicy.mockResolvedValue(null);
    const res = await svc.checkHitlGate([call('audit_log')], oversight, 3, [asCatalogued('audit_log')], 't1', 'a1', untrusted);
    expect(res).toEqual({ shouldGate: false });
  });
});
