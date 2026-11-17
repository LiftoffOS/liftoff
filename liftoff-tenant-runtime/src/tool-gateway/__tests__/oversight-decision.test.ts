// Unit tests for the extracted communication-mode oversight gate.
// Covers the decision matrix and confirms why the sandbox path treats BOTH
// `skip_for_draft` and `require_approval` as "must gate" (it can't swap an
// in-sandbox outbound call for the draft variant the way the LLM catalog can).

import { oversightDecisionFor, OUTBOUND_CATEGORIES, sensitiveWorkMatch } from '../oversight-decision';
import type { OversightSettings } from '../../hitl-enforcement/types';

function oversight(partial: Partial<OversightSettings>): OversightSettings {
  return {
    tenantId: 't1',
    autonomy: 'balanced',
    escalation: 'important',
    communication: 'review',
    sensitiveWork: {},
    ...partial,
  } as OversightSettings;
}

describe('oversightDecisionFor', () => {
  it('allows when no oversight is set', () => {
    expect(oversightDecisionFor({ categories: ['customerCommunication'] }, undefined)).toEqual({ kind: 'allow' });
  });

  it('allows non-outbound tools regardless of communication mode', () => {
    expect(oversightDecisionFor({ categories: ['read'] }, oversight({ communication: 'draft' }))).toEqual({ kind: 'allow' });
  });

  it('communication=draft blocks an outbound tool; skip_for_draft when a draftVariant exists', () => {
    const d = oversightDecisionFor(
      { categories: ['customerCommunication'], draftVariant: 'gmail__create_draft' },
      oversight({ communication: 'draft' }),
    );
    expect(d.kind).toBe('skip_for_draft');
  });

  it('communication=draft wraps with HITL when no draftVariant exists', () => {
    const d = oversightDecisionFor(
      { categories: ['outbound'] },
      oversight({ communication: 'draft' }),
    );
    expect(d).toEqual({ kind: 'require_approval', reason: 'communication_review' });
  });

  it('communication=review requires approval even when a draft form exists (the person approves the send)', () => {
    const d = oversightDecisionFor(
      { categories: ['customerCommunication'], draftVariant: 'gmail__create_draft' },
      oversight({ communication: 'review', sensitiveWork: { customerCommunication: true } }),
    );
    expect(d).toEqual({ kind: 'require_approval', reason: 'sensitive_work' });
  });

  // A native connector's send carries only the generic `outbound` category —
  // no registry names a finer class — and the toggle whose scope is external
  // email and chat is externalPublishing. Without this mapping Review had
  // nothing to match against and behaved as Send automatically for exactly the
  // tools the toggle describes.
  it('communication=review: a tool carrying only `outbound` falls under the externalPublishing toggle', () => {
    const native = { categories: ['write', 'outbound'], draftVariant: 'google-mail__create_draft' };
    expect(oversightDecisionFor(native, oversight({ communication: 'review', sensitiveWork: { externalPublishing: true } })))
      .toEqual({ kind: 'require_approval', reason: 'sensitive_work' });
    expect(oversightDecisionFor(native, oversight({ communication: 'review', sensitiveWork: { externalPublishing: false, customerCommunication: true } })))
      .toEqual({ kind: 'allow' });
  });

  it('sensitiveWorkMatch names the toggle a tool falls under, literal first', () => {
    expect(sensitiveWorkMatch({ categories: ['outbound', 'customerCommunication'] }, { customerCommunication: true, externalPublishing: true } as never))
      .toBe('customerCommunication');
    expect(sensitiveWorkMatch({ categories: ['write', 'outbound'] }, { externalPublishing: true } as never)).toBe('externalPublishing');
    expect(sensitiveWorkMatch({ categories: ['write', 'outbound'] }, { externalPublishing: false } as never)).toBeNull();
    // A workspace's own chat is not outbound and is never matched here.
    expect(sensitiveWorkMatch({ categories: ['write', 'internalCollaboration'] }, { externalPublishing: true } as never)).toBeNull();
    expect(sensitiveWorkMatch(undefined, { externalPublishing: true } as never)).toBeNull();
  });

  it('communication=review blocks only when an outbound category matches sensitiveWork', () => {
    const matching = oversightDecisionFor(
      { categories: ['customerCommunication'] },
      oversight({ communication: 'review', sensitiveWork: { customerCommunication: true } }),
    );
    expect(matching).toEqual({ kind: 'require_approval', reason: 'sensitive_work' });

    const notMatching = oversightDecisionFor(
      { categories: ['customerCommunication'] },
      oversight({ communication: 'review', sensitiveWork: { customerCommunication: false } }),
    );
    expect(notMatching).toEqual({ kind: 'allow' });
  });

  it('communication=auto always allows outbound', () => {
    expect(
      oversightDecisionFor({ categories: ['customerCommunication'] }, oversight({ communication: 'auto', sensitiveWork: { customerCommunication: true } })),
    ).toEqual({ kind: 'allow' });
  });

  it('OUTBOUND_CATEGORIES covers the three outbound classes', () => {
    expect([...OUTBOUND_CATEGORIES].sort()).toEqual(['customerCommunication', 'externalPublishing', 'outbound']);
  });
});

// Item 4 guards two directions at once. The change removed the UNSATISFIABLE case
// (demand a draft from a tool that has none), and must NOT weaken drafting where a
// draft genuinely exists — otherwise "stop choosing draft" reads as "remove drafting"
// and quietly disables the feature the Draft-first setting is for.
describe('draft substitution is preserved', () => {
  const draftOversight = {
    communication: 'draft', escalation: 'exceptions',
    sensitiveWork: {}, autonomy: 'balanced',
  } as never;

  it('still drafts an outbound tool that HAS a draftVariant', () => {
    const d = oversightDecisionFor(
      { categories: ['customerCommunication'], draftVariant: 'email_create_draft' },
      draftOversight,
    );
    expect(d).toEqual({ kind: 'skip_for_draft' });
  });

  it('asks for an approvable pause when the outbound tool has NO draftVariant', () => {
    const d = oversightDecisionFor({ categories: ['customerCommunication'] }, draftOversight);
    expect(d.kind).toBe('require_approval');
  });

  // Slack/Teams are internalCollaboration after the retag, so the outbound policy must
  // not touch them at all — this is what unblocks posting to an internal channel.
  it('leaves internal collaboration tools alone under Draft-first', () => {
    const d = oversightDecisionFor({ categories: ['internalCollaboration'] }, draftOversight);
    expect(d).toEqual({ kind: 'allow' });
  });
});
