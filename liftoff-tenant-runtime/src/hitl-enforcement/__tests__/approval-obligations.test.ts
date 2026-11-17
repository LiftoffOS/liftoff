// What a "yes" covers is computed, never authored, and it is computed the
// same way twice.
//
// The evaluator's whole use is a comparison between a set recorded at approval
// and a set recomputed at consumption, so it has to be a function of its inputs
// and nothing else; and every code it can return has to be a reason a person
// can be shown on /dashboard/review, because the re-ask is about that reason.
// The gate answers with the FIRST reason by precedence and this returns the
// SET; the two must agree on the first, or a grant recorded from one would be
// judged by the other.

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

import type { GateReason } from '@liftoffos/governance-types';
import {
  evaluateApprovalObligations,
  uncoveredObligations,
  OBLIGATION_EVALUATOR_VERSION,
  REASON_PRECEDENCE,
  type ObligationConfig,
} from '../approval-obligations';
import { hitlEnforcementService } from '../service';
import { maybeConvertToDraft } from '../../agent-execution/tool-interceptor';
import { HitlGateError } from '../types';
import type { ModelTool, ToolCallRequest } from '../types';
import { DEFAULT_QUANTIFIER_THRESHOLDS } from '../../tool-gateway/plan-quantifier';

const TOOLS: ModelTool[] = [
  { name: 'crm__delete_contact', description: '⚠️ DESTRUCTIVE Delete a contact', inputSchema: {}, effect: 'write', categories: ['dataChanges'] } as ModelTool,
  { name: 'gmail__send_email', description: 'Send an email', inputSchema: {}, effect: 'write', categories: ['customerCommunication', 'outbound'] } as ModelTool,
  { name: 'crm__archive_records', description: 'Archive records', inputSchema: {}, effect: 'write', categories: [] } as ModelTool,
  { name: 'crm__get_contact', description: 'Read a contact', inputSchema: {}, effect: 'read', categories: ['read'] } as ModelTool,
  // A native connector send: the registry names no finer class than `outbound`.
  { name: 'google-mail__send_email', description: 'Send an email', inputSchema: {}, effect: 'write', categories: ['write', 'outbound'] } as ModelTool,
];

const oversight = (over: Partial<ObligationConfig['oversight']> = {}) => ({
  tenantId: 't1', autonomy: 'balanced', escalation: 'sensitive',
  sensitiveWork: {}, communication: 'auto', ...over,
}) as ObligationConfig['oversight'];

const call = (name: string, input: Record<string, unknown> = {}): ToolCallRequest => ({ id: `c-${name}`, name, input });

const base = (over: Partial<ObligationConfig> = {}): ObligationConfig => ({
  hitlLevel: 3, oversight: oversight(), tools: TOOLS, standingPolicies: {}, ...over,
});

describe('the evaluator is a function of its inputs', () => {
  it('returns the same set for the same input, every time', () => {
    const calls = [call('crm__delete_contact', { id: 'x' })];
    const config = base({ hitlLevel: 2, oversight: oversight({ sensitiveWork: { dataChanges: true } }) });
    const a = evaluateApprovalObligations(calls, config);
    const b = evaluateApprovalObligations(calls, config);
    expect(a).toEqual(b);
    expect(a.reasons).toEqual(['destructive_gate', 'sensitive_work']);
  });

  it('is versioned', () => {
    expect(evaluateApprovalObligations([], base()).version).toBe(OBLIGATION_EVALUATOR_VERSION);
    expect(OBLIGATION_EVALUATOR_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('returns nothing for nothing, and nothing for a read', () => {
    expect(evaluateApprovalObligations([], base()).reasons).toEqual([]);
    expect(evaluateApprovalObligations([call('crm__get_contact')], base({ hitlLevel: 2 })).reasons).toEqual([]);
  });

  it('every reason it can return is one the review queue can show', () => {
    // The set this can emit is the precedence list, and the precedence list
    // is derived from a Record over the shared `GateReason` union — so it is
    // the union, exhaustively, by compilation: a member added to
    // @liftoffos/governance-types without a rank does not compile, and neither
    // does a rank for a member the union lost. The review queue's label map is
    // held to that same union by the web app's fence
    // (oversight.vocabulary.test.ts), so the chain closes with no hand-copied
    // list on either side. What is left to assert at runtime is that the
    // ranks are a total order: no reason twice, none skipped.
    const distinct = new Set(REASON_PRECEDENCE);
    expect(distinct.size).toBe(REASON_PRECEDENCE.length);
    const asUnion: GateReason[] = [...REASON_PRECEDENCE];
    expect(asUnion.length).toBeGreaterThanOrEqual(9);
    // The gate's own first-reason order, pinned: the invariants before the
    // level gates, kind before size, review last.
    expect(REASON_PRECEDENCE.indexOf('super_destructive_gate')).toBeLessThan(REASON_PRECEDENCE.indexOf('level_1_gate'));
    expect(REASON_PRECEDENCE.indexOf('destructive_gate')).toBeLessThan(REASON_PRECEDENCE.indexOf('blast_radius'));
    expect(REASON_PRECEDENCE[REASON_PRECEDENCE.length - 1]).toBe('communication_review');
  });
});

describe('the reasons, one at a time', () => {
  it('level 1 asks for everything', () => {
    expect(evaluateApprovalObligations([call('crm__get_contact')], base({ hitlLevel: 1 })).reasons).toEqual(['level_1_gate']);
  });

  it('level 2 asks for a destructive marker', () => {
    expect(evaluateApprovalObligations([call('crm__delete_contact')], base({ hitlLevel: 2 })).reasons).toEqual(['destructive_gate']);
    // Not at level 3: the marker is a level-2 rule.
    expect(evaluateApprovalObligations([call('crm__delete_contact')], base({ hitlLevel: 3 })).reasons).toEqual([]);
  });

  it('sensitive work asks when the category is switched on, and only then', () => {
    const calls = [call('gmail__send_email')];
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ sensitiveWork: { customerCommunication: true } }) })).reasons)
      .toEqual(['sensitive_work']);
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ sensitiveWork: { customerCommunication: false } }) })).reasons)
      .toEqual([]);
    // The escalation setting gates the whole category path.
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ escalation: 'exceptions', sensitiveWork: { customerCommunication: true } }) })).reasons)
      .toEqual([]);
  });

  it('Review asks for a native send that falls under an enabled toggle, whatever the escalation setting', () => {
    const calls = [call('google-mail__send_email')];
    // A native send carries only the generic `outbound`; the pre-check reads that as external publishing.
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ escalation: 'exceptions', communication: 'review', sensitiveWork: { externalPublishing: true } }) })).reasons)
      .toEqual(['sensitive_work']);
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ escalation: 'exceptions', communication: 'review', sensitiveWork: { externalPublishing: false } }) })).reasons)
      .toEqual([]);
    // Under Auto the pre-check lets it through, and so does this.
    expect(evaluateApprovalObligations(calls, base({ oversight: oversight({ communication: 'auto', sensitiveWork: { externalPublishing: true } }) })).reasons)
      .toEqual([]);
    // Not a rule about sends in general: a read under Review asks nothing.
    expect(evaluateApprovalObligations([call('crm__get_contact')], base({ oversight: oversight({ communication: 'review', sensitiveWork: { externalPublishing: true } }) })).reasons)
      .toEqual([]);
  });

  it('Draft-first asks once about an outbound call the pre-check would have drafted or held', () => {
    expect(evaluateApprovalObligations([call('google-mail__send_email')], base({ oversight: oversight({ escalation: 'exceptions', communication: 'draft' }) })).reasons)
      .toEqual(['communication_review']);
    expect(evaluateApprovalObligations([call('crm__archive_records')], base({ oversight: oversight({ communication: 'draft' }) })).reasons)
      .toEqual([]);
  });

  it('size asks when a batch names more records than it may touch, with the measurement', () => {
    const ids = Array.from({ length: DEFAULT_QUANTIFIER_THRESHOLDS.maxEntitiesPerBatch + 1 }, (_, i) => `r${i}`);
    const out = evaluateApprovalObligations([call('crm__archive_records', { ids })], base());
    expect(out.reasons).toEqual(['blast_radius']);
    expect(out.measuredReasons?.join(' ')).toMatch(/\d+/);
  });

  it('an untrusted run asks for a write it cannot place, and not for a read', () => {
    const cfg = base({ trustLevel: 'untrusted_inbound' });
    expect(evaluateApprovalObligations([call('crm__archive_records', { ids: ['a'] })], cfg).reasons).toEqual(['external_content_write']);
    expect(evaluateApprovalObligations([call('crm__get_contact')], cfg).reasons).toEqual([]);
    // Outbound is the Communication policy's to govern, not this invariant's.
    expect(evaluateApprovalObligations([call('gmail__send_email')], cfg).reasons).toEqual([]);
  });

  it('a standing approval clears the reason it names — never super-destructive', () => {
    const calls = [call('crm__delete_contact')];
    expect(evaluateApprovalObligations(calls, base({ hitlLevel: 2, standingPolicies: { destructive_gate: { decision: 'approved' } } })).reasons)
      .toEqual([]);
    expect(evaluateApprovalObligations(calls, base({ hitlLevel: 2, standingPolicies: { destructive_gate: { decision: 'rejected' } } })).reasons)
      .toEqual(['destructive_gate']);
    // external_content_write clears only under a class-scoped policy covering every call.
    const untrusted = base({ trustLevel: 'untrusted_inbound' });
    const write = [call('crm__archive_records', { ids: ['a'] })];
    expect(evaluateApprovalObligations(write, { ...untrusted, standingPolicies: { external_content_write: { decision: 'approved' } } }).reasons)
      .toEqual(['external_content_write']);
    expect(evaluateApprovalObligations(write, { ...untrusted, standingPolicies: { external_content_write: { decision: 'approved', actionClasses: ['archive_records'] } } }).reasons)
      .toEqual([]);
  });
});

describe('the set and the gate agree on the first reason', () => {
  // The gate short-circuits and this does not; on the reason a person is
  // actually shown, the two must say the same thing, or a grant computed here
  // is judged by rules the gate does not follow.
  const cases: Array<[string, ToolCallRequest[], ObligationConfig]> = [
    ['a destructive call at level 2', [call('crm__delete_contact')], base({ hitlLevel: 2 })],
    ['a sensitive send', [call('gmail__send_email')], base({ oversight: oversight({ sensitiveWork: { customerCommunication: true } }) })],
    ['level 1', [call('crm__get_contact')], base({ hitlLevel: 1 })],
    ['an untrusted write', [call('crm__archive_records', { ids: ['a'] })], base({ trustLevel: 'untrusted_inbound' })],
    ['a plain read', [call('crm__get_contact')], base({ hitlLevel: 2 })],
    ['a destructive call that is also sensitive', [call('crm__delete_contact')], base({ hitlLevel: 2, oversight: oversight({ sensitiveWork: { dataChanges: true } }) })],
  ];

  it.each(cases)('%s', async (_name, calls, config) => {
    const gate = await hitlEnforcementService.checkHitlGate(
      calls, config.oversight, config.hitlLevel, config.tools, 't1', 'a1',
      { dryRun: true, trustLevel: config.trustLevel, externalContentGateDisabled: config.externalContentGateDisabled },
    );
    const set = evaluateApprovalObligations(calls, config);
    if (gate.shouldGate) {
      expect(set.reasons[0]).toBe(gate.reason);
    } else {
      expect(set.reasons).toEqual([]);
    }
  });
});

describe('the set and the Communication pre-check agree', () => {
  // The pre-check runs ahead of the gate on every call and pauses on its own
  // account; a control it enforces is one the set has to carry, or tightening
  // Communication between the yes and the resume would never re-ask.
  const precheck = (calls: ToolCallRequest[], config: ObligationConfig): GateReason | null => {
    try {
      for (const c of calls) maybeConvertToDraft(c, config.oversight, config.tools);
      return null;
    } catch (err) {
      if (err instanceof HitlGateError) return err.reason as GateReason;
      throw err;
    }
  };

  it.each<[string, ToolCallRequest[], ObligationConfig]>([
    ['a native send under Review with publishing on', [call('google-mail__send_email')], base({ oversight: oversight({ escalation: 'exceptions', communication: 'review', sensitiveWork: { externalPublishing: true } }) })],
    ['a native send under Review with publishing off', [call('google-mail__send_email')], base({ oversight: oversight({ communication: 'review', sensitiveWork: { externalPublishing: false } }) })],
    ['a native send with no draft form under Draft-first', [call('google-mail__send_email')], base({ oversight: oversight({ escalation: 'exceptions', communication: 'draft' }) })],
    ['a write that is not outbound under Draft-first', [call('crm__archive_records')], base({ oversight: oversight({ communication: 'draft' }) })],
    ['a native send under Auto', [call('google-mail__send_email')], base({ oversight: oversight({ communication: 'auto', sensitiveWork: { externalPublishing: true } }) })],
  ])('%s', (_name, calls, config) => {
    const reason = precheck(calls, config);
    const set = evaluateApprovalObligations(calls, config);
    if (reason) expect(set.reasons).toContain(reason);
    else expect(set.reasons).toEqual([]);
  });

  it('a send the pre-check would draft rather than hold is still asked about once — the consumption point cannot draft', () => {
    const tools: ModelTool[] = [
      { name: 'google-mail__send_email', description: 'Send', inputSchema: {}, effect: 'write', categories: ['write', 'outbound'], draftVariant: 'create_draft' } as ModelTool,
    ];
    const config = base({ tools, oversight: oversight({ communication: 'draft' }) });
    expect(maybeConvertToDraft(call('google-mail__send_email'), config.oversight, tools).name).toBe('google-mail__create_draft');
    expect(evaluateApprovalObligations([call('google-mail__send_email')], config).reasons).toEqual(['communication_review']);
  });
});

describe('what the grant did not cover', () => {
  it('is empty when the grant covers the current set', () => {
    expect(uncoveredObligations({ version: OBLIGATION_EVALUATOR_VERSION, reasons: ['destructive_gate', 'sensitive_work'] },
      { version: OBLIGATION_EVALUATOR_VERSION, reasons: ['destructive_gate'] })).toEqual([]);
  });

  it('is the tightened reason, and only that', () => {
    expect(uncoveredObligations({ version: OBLIGATION_EVALUATOR_VERSION, reasons: ['destructive_gate'] },
      { version: OBLIGATION_EVALUATOR_VERSION, reasons: ['destructive_gate', 'sensitive_work'] })).toEqual(['sensitive_work']);
  });

  it('treats a grant from another evaluator version as covering nothing', () => {
    expect(uncoveredObligations({ version: OBLIGATION_EVALUATOR_VERSION + 1, reasons: ['destructive_gate'] },
      { version: OBLIGATION_EVALUATOR_VERSION, reasons: ['destructive_gate'] })).toEqual(['destructive_gate']);
  });

  it('treats no grant as covering nothing', () => {
    expect(uncoveredObligations(null, { version: OBLIGATION_EVALUATOR_VERSION, reasons: ['blast_radius'] })).toEqual(['blast_radius']);
  });
});
