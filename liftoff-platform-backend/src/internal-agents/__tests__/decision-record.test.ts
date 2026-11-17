// Configuration provenance, and the diff that makes a redistill a merge.
//
// The failure this exists for is not hypothetical and is worst where the
// feature is most used: in the conversational build loop a person says "this
// team has no email", the distiller writes it into prose, and the next "tweak
// my agent" reverses it. Prose is not a decision — it is a sentence a later
// generation is free to rewrite.

import {
  buildDecisionRecord,
  diffDecisionRecords,
  renderDecisionRecordSection,
} from '../decision-record';

describe('buildDecisionRecord', () => {
  it('derives the trigger WITH its reason', () => {
    // The reason is the load-bearing half. "cron" alone gets re-derived from
    // prose; "cron because no webhook-capable connector was bound" says the
    // choice was forced and can be revisited the day one is.
    const r = buildDecisionRecord({
      triggerConfig: { type: 'cron', reasoning: 'no webhook-capable connector bound' },
    });
    expect(r.trigger).toEqual({ type: 'cron', reason: 'no webhook-capable connector bound' });
  });

  it('takes the two members only the model can know', () => {
    const r = buildDecisionRecord({
      fromModel: {
        cadenceClamps: [{ requested: 'every minute', applied: '*/5', reason: 'platform floor' }],
        assumptions: [{ about: 'branch', assumed: 'main' }],
      },
    });
    expect(r.cadenceClamps).toHaveLength(1);
    expect(r.assumptions).toHaveLength(1);
  });

  it('omits empty members rather than storing empty arrays', () => {
    // A record full of empty keys teaches a reader that the section is usually
    // empty and can be skimmed.
    const r = buildDecisionRecord({});
    expect(r.trigger).toBeUndefined();
    expect(r.cadenceClamps).toBeUndefined();
    expect(r.recordedAt).toBeDefined();
  });

  it('degrades gracefully when the model supplies nothing', () => {
    // Why omission is cheap, and why this does not belong in the strict
    // capability branch: the code-derived members survive on their own.
    const r = buildDecisionRecord({
      triggerConfig: { type: 'event', reasoning: 'pr.opened is bound' },
      capabilityStates: { email_communication: 'absent' },
      distilledOverrideTools: ['create_review_comment'],
    });
    expect(r.trigger?.type).toBe('event');
    expect(r.capabilityStates).toEqual({ email_communication: 'absent' });
    expect(r.distilledOverrideTools).toEqual(['create_review_comment']);
  });
});

describe('diffDecisionRecords', () => {
  it('reports a trigger reversal', () => {
    const d = diffDecisionRecords(
      { trigger: { type: 'event', reason: 'x' } },
      { trigger: { type: 'cron', reason: 'y' } },
    );
    expect(d).toEqual([{ field: 'trigger.type', was: 'event', now: 'cron' }]);
  });

  it('reports absent being restored, which is forgetting rather than learning', () => {
    // `absent` is a fact about the BUSINESS, not about today's bindings.
    const d = diffDecisionRecords(
      { capabilityStates: { email_communication: 'absent' } },
      { capabilityStates: { email_communication: 'unwired' } },
    );
    expect(d).toEqual([{ field: 'capability.email_communication', was: 'absent', now: 'unwired' }]);
  });

  it('says nothing when the decisions held', () => {
    const same = { trigger: { type: 'cron', reason: 'r' }, capabilityStates: { a: 'live' as const } };
    expect(diffDecisionRecords(same, same)).toEqual([]);
  });

  it('says nothing on a first distillation', () => {
    expect(diffDecisionRecords(undefined, { trigger: { type: 'cron', reason: '' } })).toEqual([]);
  });
});

describe('renderDecisionRecordSection', () => {
  it('is empty when there is nothing recorded', () => {
    // A heading with no content teaches the model the section can be skimmed.
    expect(renderDecisionRecordSection({})).toBe('');
    expect(renderDecisionRecordSection(undefined)).toBe('');
  });

  it('arrives as a constraint with a stated escape, not as background', () => {
    const out = renderDecisionRecordSection({ trigger: { type: 'cron', reason: 'forced' } });
    expect(out).toContain('DECISIONS ALREADY MADE');
    expect(out).toContain('Honour them unless');
    expect(out).toContain('cron');
  });

  it('says what absent means, where the model will read it', () => {
    const out = renderDecisionRecordSection({ capabilityStates: { email_communication: 'absent' } });
    expect(out).toContain('absent');
    expect(out).toContain('never will');
  });
});
