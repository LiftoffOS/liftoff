// The outcome matrix at consumption, one row per test, and the fingerprint
// over the calls that will run.
//
// `consumeApprovedCalls` is the one place an approved call is consumed for
// dispatch. Each row of its matrix is a promise to the person who approved:
// never asked twice for the same thing, never once for a thing they did not
// approve, and never dispatched under a yes the settings no longer cover.

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantScope: jest.fn(),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
}));
jest.mock('../../infrastructure/logging', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log, logger: log, logAudit: jest.fn() };
});
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../platform-callback/client', () => ({ postSkillFeedback: jest.fn() }));
jest.mock('../../clients/platform-backend-client', () => ({ fetchOversightSettings: jest.fn() }));

import { consumeApprovedCalls, finalCallsFor, grantCovers, reaskIdempotencyKey, type ConsumptionInputs } from '../approval-consumption';
import { OBLIGATION_EVALUATOR_VERSION, type ObligationConfig } from '../../hitl-enforcement/approval-obligations';
import { hitlEnforcementService } from '../../hitl-enforcement';
import type { HitlApprovalRequest, ModelTool, ToolCallRequest } from '../../hitl-enforcement/types';
import type { McpToolCatalog } from '../adapter/catalog-types';

const TOOLS: ModelTool[] = [
  { name: 'crm__delete_contact', description: '⚠️ DESTRUCTIVE Delete a contact', inputSchema: {}, effect: 'write', categories: ['dataChanges'] } as ModelTool,
];
const PENDING: ToolCallRequest[] = [{ id: 'pc1', name: 'crm__delete_contact', input: { id: 'contact-7' } }];

/** The continuation's catalog, as the hire's CURRENT bindings produce it: the
 *  CRM is still bound, so its tool has an entry the routing resolves. */
const CATALOG: McpToolCatalog = {
  servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { type: 'sdk', name: 'liftoff-tool-gateway', instance: {} as never } }],
  tools: [{ name: 'crm__delete_contact', description: 'Delete a contact', inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway', source: 'connector' } as McpToolCatalog['tools'][number]],
};
/** The same hire after the CRM was unbound: the catalog has no entry for it. */
const CATALOG_WITHOUT_CRM: McpToolCatalog = { ...CATALOG, tools: [] };

function config(over: Partial<ObligationConfig> = {}): ObligationConfig {
  return {
    hitlLevel: 2,
    oversight: { tenantId: 't1', autonomy: 'balanced', escalation: 'sensitive', sensitiveWork: {}, communication: 'auto' },
    tools: TOOLS,
    standingPolicies: {},
    ...over,
  };
}

/** An approval as the row reads back after a person said yes to PENDING under
 *  `config()`: the grant recorded the destructive reason. */
function approval(over: Partial<HitlApprovalRequest> = {}): HitlApprovalRequest {
  const { fingerprint } = finalCallsFor(PENDING, null);
  return {
    id: 'appr-1', tenantId: 't1', workflowId: '', taskId: '', agentId: 'a1', hitlLevel: 2,
    pendingToolCalls: PENDING,
    toolCallsHash: hitlEnforcementService.hashToolCalls(PENDING),
    reason: 'destructive_gate', status: 'approved', decidedBy: 'u1', decidedByRole: 'admin',
    decision: 'approved', rejectionReason: null, decidedAt: new Date(), idempotencyKey: null,
    expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date(), updatedAt: new Date(),
    injectedSkillIds: [], source: 'agent', context: null,
    editedToolInputs: null,
    finalToolCallsHash: fingerprint,
    grantedObligations: ['destructive_gate'],
    obligationsEvaluatorVersion: OBLIGATION_EVALUATOR_VERSION,
    gateView: { tools: TOOLS },
    ...over,
  } as HitlApprovalRequest;
}

function inputs(over: Partial<ConsumptionInputs> = {}): ConsumptionInputs {
  return {
    approval: approval(),
    pendingToolCalls: PENDING,
    currentConfig: async () => config(),
    catalog: CATALOG,
    isStandardTool: () => false,
    admission: async () => ({ allowed: true }),
    provenanceHold: async () => null,
    ...over,
  };
}

describe('the fingerprint over the calls that will run', () => {
  it('is over the edited calls, not the proposed ones', () => {
    const proposed = finalCallsFor(PENDING, null);
    const edited = finalCallsFor(PENDING, { pc1: { id: 'contact-8' } });
    expect(edited.finalCalls[0].input).toEqual({ id: 'contact-8' });
    expect(edited.fingerprint).not.toBe(proposed.fingerprint);
    // And the proposal hash is untouched by an edit: the two records are kept apart.
    expect(hitlEnforcementService.hashToolCalls(PENDING)).toBe(proposed.fingerprint);
  });

  it('a grant covers exactly its calls: same ids, same arguments, no more, no fewer', () => {
    const { finalCalls, fingerprint } = finalCallsFor(PENDING, null);
    const grant = { approvalId: 'appr-1', finalCalls, fingerprint };
    expect(grantCovers(grant, [{ id: 'pc1', payload: { id: 'contact-7' } }])).toBe(true);
    // The same call, keys in another order: still the same call.
    expect(grantCovers(grant, [{ id: 'pc1', payload: JSON.parse('{"id":"contact-7"}') }])).toBe(true);
    expect(grantCovers(grant, [{ id: 'pc1', payload: { id: 'contact-8' } }])).toBe(false);
    expect(grantCovers(grant, [{ id: 'pc2', payload: { id: 'contact-7' } }])).toBe(false);
    expect(grantCovers(grant, [{ id: 'pc1', payload: { id: 'contact-7' } }, { id: 'pc2', payload: {} }])).toBe(false);
    expect(grantCovers(grant, [])).toBe(false);
    // A subset of a two-call grant is covered: the approved calls are routed by
    // ownership and the dispatcher sees only its share.
    const two = finalCallsFor([...PENDING, { id: 'pc2', name: 'sleep_until', input: { until: 'later' } }], null);
    const wide = { approvalId: 'appr-1', finalCalls: two.finalCalls, fingerprint: two.fingerprint };
    expect(grantCovers(wide, [{ id: 'pc1', payload: { id: 'contact-7' } }])).toBe(true);
    expect(grantCovers(wide, [{ id: 'pc2', payload: { until: 'later' } }])).toBe(true);
    expect(grantCovers(wide, [{ id: 'pc2', payload: { until: 'now' } }])).toBe(false);
  });
});

describe('the outcome matrix', () => {
  it('same final calls, granted set covers the current set → consume, dispatch once', async () => {
    const out = await consumeApprovedCalls(inputs());
    expect(out.kind).toBe('dispatch');
    if (out.kind === 'dispatch') {
      expect(out.grant.approvalId).toBe('appr-1');
      expect(out.grant.finalCalls).toEqual(PENDING);
      expect(out.grant.fingerprint).toBe(approval().finalToolCallsHash);
    }
  });

  it('a covering grant with the edits applied dispatches the EDITED calls', async () => {
    const edits = { pc1: { id: 'contact-8' } };
    const { fingerprint } = finalCallsFor(PENDING, edits);
    const out = await consumeApprovedCalls(inputs({ approval: approval({ editedToolInputs: edits, finalToolCallsHash: fingerprint }) }));
    expect(out.kind).toBe('dispatch');
    if (out.kind === 'dispatch') expect(out.grant.finalCalls[0].input).toEqual({ id: 'contact-8' });
  });

  it('final-call fingerprint differs → new approval (idempotent), do not dispatch', async () => {
    // The grant was recorded over one set of final calls; the edits now on
    // the row produce another. That is a different action from the one approved.
    const out = await consumeApprovedCalls(inputs({ approval: approval({ editedToolInputs: { pc1: { id: 'someone-else' } } }) }));
    expect(out.kind).toBe('reask');
    if (out.kind === 'reask') {
      expect(out.why).toBe('fingerprint_mismatch');
      expect(out.idempotencyKey).toBe(reaskIdempotencyKey('appr-1', out.fingerprint));
      expect(out.finalCalls[0].input).toEqual({ id: 'someone-else' });
    }
  });

  it('a new or stricter reason appeared → new approval about that reason only', async () => {
    // Between approval and resume, sensitive-work review was switched on for
    // the category this call carries. The destructive reason was covered; the
    // sensitive one was not, and it is the only one asked about.
    const out = await consumeApprovedCalls(inputs({
      currentConfig: async () => config({ oversight: { tenantId: 't1', autonomy: 'balanced', escalation: 'sensitive', sensitiveWork: { dataChanges: true }, communication: 'auto' } }),
    }));
    expect(out.kind).toBe('reask');
    if (out.kind === 'reask') {
      expect(out.why).toBe('stricter_reason');
      expect(out.reasons).toEqual(['sensitive_work']);
      expect(out.idempotencyKey).toBe(reaskIdempotencyKey('appr-1', out.fingerprint));
    }
  });

  it('a grant from another evaluator version is not read as covering anything', async () => {
    const out = await consumeApprovedCalls(inputs({ approval: approval({ obligationsEvaluatorVersion: OBLIGATION_EVALUATOR_VERSION + 1 }) }));
    expect(out.kind).toBe('reask');
    if (out.kind === 'reask') expect(out.reasons).toEqual(['destructive_gate']);
  });

  it('a control LOOSENED in between still dispatches: the grant covers a superset', async () => {
    const out = await consumeApprovedCalls(inputs({ currentConfig: async () => config({ hitlLevel: 3 }) }));
    expect(out.kind).toBe('dispatch');
  });

  it('connector or tool no longer exists → configuration error', async () => {
    // Judged by the catalog the hire's current bindings produce, through the
    // same routing the dispatch runs (approved-call-routing.ts) — never by the
    // shape of the name.
    const out = await consumeApprovedCalls(inputs({ catalog: CATALOG_WITHOUT_CRM }));
    expect(out.kind).toBe('configuration_error');
    if (out.kind === 'configuration_error') expect(out.detail).toContain('crm__delete_contact');
  });

  it('a send Draft-first withheld from the model is still bound: asked about the tightened setting, never a configuration error', async () => {
    // A yes on a native send under Review; Communication moved to Draft-first
    // before the resume. The continuation's catalog offers the draft form and
    // withholds the send — but the send is bound, and the person approved it.
    const SEND: ModelTool = { name: 'google-mail-1a2b__send_email', description: 'Send', inputSchema: {}, effect: 'write', categories: ['write', 'outbound'] } as ModelTool;
    const pending: ToolCallRequest[] = [{ id: 'pc1', name: 'google-mail-1a2b__send_email', input: { to: 'a@b.c' } }];
    const { fingerprint } = finalCallsFor(pending, null);
    const review = { tenantId: 't1', autonomy: 'balanced', escalation: 'exceptions', sensitiveWork: { externalPublishing: true }, communication: 'review' } as const;
    const catalog: McpToolCatalog = {
      ...CATALOG,
      tools: [{ name: 'google-mail-1a2b__create_draft', description: 'Draft', inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway', source: 'connector' } as McpToolCatalog['tools'][number]],
      withheldByOversight: [{ name: 'google-mail-1a2b__send_email', description: 'Send', inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway', source: 'connector', categories: ['write', 'outbound'], draftVariant: 'create_draft' } as McpToolCatalog['tools'][number]],
    };
    const base = inputs({
      approval: approval({
        pendingToolCalls: pending, toolCallsHash: hitlEnforcementService.hashToolCalls(pending), reason: 'sensitive_work',
        finalToolCallsHash: fingerprint, grantedObligations: ['sensitive_work'], gateView: { tools: [SEND] },
      }),
      pendingToolCalls: pending,
      catalog,
    });
    const tightened = await consumeApprovedCalls({ ...base, currentConfig: async () => config({ hitlLevel: 3, tools: [SEND], oversight: { ...review, communication: 'draft' } }) });
    expect(tightened.kind).toBe('reask');
    if (tightened.kind === 'reask') expect(tightened.reasons).toEqual(['communication_review']);
    // And once the person has said yes to that too, the send dispatches through
    // the gateway as a connector call.
    const covered = await consumeApprovedCalls({
      ...base,
      approval: approval({
        pendingToolCalls: pending, toolCallsHash: hitlEnforcementService.hashToolCalls(pending), reason: 'communication_review',
        finalToolCallsHash: fingerprint, grantedObligations: ['sensitive_work', 'communication_review'], gateView: { tools: [SEND] },
      }),
      currentConfig: async () => config({ hitlLevel: 3, tools: [SEND], oversight: { ...review, communication: 'draft' } }),
    });
    expect(covered.kind).toBe('dispatch');
    if (covered.kind === 'dispatch') expect(covered.grant.routes[0]).toMatchObject({ ownership: 'connector', dispatchPath: 'execute_tool_calls', resolvedName: 'google-mail-1a2b__send_email' });
  });

  it('a dispatchable grant carries the route each final call takes, decided once at consumption', async () => {
    const out = await consumeApprovedCalls(inputs());
    expect(out.kind).toBe('dispatch');
    if (out.kind === 'dispatch') {
      expect(out.grant.routes).toHaveLength(1);
      expect(out.grant.routes[0]).toMatchObject({
        ownership: 'connector',
        dispatchPath: 'execute_tool_calls',
        resolvedName: 'crm__delete_contact',
        request: { id: 'pc1', connector: 'crm', actionType: 'delete_contact', payload: { id: 'contact-7' } },
      });
    }
  });

  it('admission now denies execution → stop or defer', async () => {
    const out = await consumeApprovedCalls(inputs({ admission: async () => ({ allowed: false, reason: 'billing_suspended' }) }));
    expect(out).toEqual({ kind: 'admission_denied', detail: 'billing_suspended' });
  });

  it('provenance requires a read first → the provenance hold, not an approval', async () => {
    const out = await consumeApprovedCalls(inputs({ provenanceHold: async () => 'Read contact-7 before acting on it.' }));
    expect(out.kind).toBe('provenance_hold');
    if (out.kind === 'provenance_hold') {
      expect(out.held).toEqual([{ call: expect.objectContaining({ id: 'pc1' }), message: 'Read contact-7 before acting on it.' }]);
      // The grant still stands, carrying the hold: the held call is answered
      // with it in place, not run, and nothing about it is asked of a person.
      expect(out.grant.approvalId).toBe('appr-1');
      expect(out.grant.holds).toEqual({ pc1: 'Read contact-7 before acting on it.' });
    }
  });

  it('current reasons cannot be established → defer, never consume the old grant', async () => {
    const out = await consumeApprovedCalls(inputs({ currentConfig: async () => { throw new Error('governance engine unreachable'); } }));
    expect(out.kind).toBe('defer');
    if (out.kind === 'defer') expect(out.detail).toContain('governance engine unreachable');
  });

  it('an approval that is not for the calls this pause holds is refused outright', async () => {
    const out = await consumeApprovedCalls(inputs({ pendingToolCalls: [{ id: 'pc1', name: 'crm__delete_contact', input: { id: 'not-what-was-approved' } }] }));
    expect(out.kind).toBe('refuse');
  });

  it('a row decided before the grant existed asks about every reason in force', async () => {
    // NULL fingerprint, NULL grant (pre-migration-409): nothing to verify the
    // calls against and nothing the yes is recorded as covering, so the
    // current set is asked about in full rather than assumed.
    const out = await consumeApprovedCalls(inputs({ approval: approval({ finalToolCallsHash: null, grantedObligations: null, obligationsEvaluatorVersion: null }) }));
    expect(out.kind).toBe('reask');
    if (out.kind === 'reask') expect(out.reasons).toEqual(['destructive_gate']);
  });

  it('checks the connector before the settings, so a missing tool is never asked about', async () => {
    const out = await consumeApprovedCalls(inputs({
      catalog: CATALOG_WITHOUT_CRM,
      currentConfig: async () => { throw new Error('should not be read'); },
    }));
    expect(out.kind).toBe('configuration_error');
  });
});
