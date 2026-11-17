// The grounding floor, and the two ways a matcher gets this wrong.
//
// `groundsOn` declares which read a request's SHAPE needs. It is the FLOOR, not
// the optimisation: it works identically on every engine because no engine is
// asked to produce it. Native tool-forcing is an improvement on top, and an
// engine that cannot force still gets this.

import {
  turnMatchesRule,
  ruleForTurn,
  groundingBlock,
  runGroundingPrefetch,
  GROUNDING_PREFETCH_DEADLINE_MS,
  type GroundsOnRule,
} from '../grounding-prefetch';

const POLICY: GroundsOnRule = {
  label: 'the help centre',
  terms: ['refund', 'policy', 'cancel'],
  cues: ['what', 'how', '?'],
  toolName: 'corpus_search',
  enabled: true,
};

describe('turnMatchesRule', () => {
  it('matches a term AND a cue', () => {
    expect(turnMatchesRule('What is your refund policy?', POLICY)).toBe(true);
  });

  it('does not match a term with no cue', () => {
    // "I already refunded them" is a statement about work done, not a question
    // needing the policy. A term alone would ground half the conversation.
    expect(turnMatchesRule('I already refunded them yesterday.', POLICY)).toBe(false);
  });

  it('does not match a cue with no term', () => {
    expect(turnMatchesRule('What time is the meeting?', POLICY)).toBe(false);
  });

  it('is WHOLE-WORD', () => {
    // Substring matching fires "cancel" on "cancer", which is the kind of
    // mistake that is only ever noticed by the person it happens to.
    expect(turnMatchesRule('What does a cancer diagnosis mean for cover?', POLICY)).toBe(false);
  });

  it('respects enabled:false without needing the rule deleted', () => {
    expect(turnMatchesRule('What is your refund policy?', { ...POLICY, enabled: false })).toBe(false);
  });

  it('handles an empty turn', () => {
    expect(turnMatchesRule('', POLICY)).toBe(false);
  });
});

describe('ruleForTurn', () => {
  const STATUS: GroundsOnRule = {
    label: 'the work queue', terms: ['ticket'], cues: ['where', '?'],
    toolName: 'list_tickets', enabled: true,
  };

  it('takes the FIRST match, not all of them', () => {
    // Two prefetches on one turn is two tool calls nobody asked for, and the
    // second is nearly always the weaker match.
    const r = ruleForTurn('Where is my ticket and what is your refund policy?', [POLICY, STATUS]);
    expect(r?.toolName).toBe('corpus_search');
  });

  it('is null when nothing matches', () => {
    expect(ruleForTurn('hello', [POLICY, STATUS])).toBeNull();
    expect(ruleForTurn('hello', undefined)).toBeNull();
  });
});

describe('groundingBlock', () => {
  it('says what it is and where it came from', () => {
    // Unlabelled, a paste is indistinguishable from the person quoting their
    // own help centre, and an agent cannot weigh a source it cannot see.
    const b = groundingBlock(POLICY, 'Refunds within 30 days.');
    expect(b).toContain('Fetched by the host');
    expect(b).toContain('corpus_search');
    expect(b).toContain('Refunds within 30 days.');
  });
});

describe('runGroundingPrefetch', () => {
  const base = { tenantId: 't', agentId: 'a', rules: [POLICY] };

  it('runs the read through the injected gateway dispatch', async () => {
    // Injected precisely so this module never holds a connector client — the
    // only way to be sure the gates, the framing and the metering are the ones
    // the agent's own calls get.
    const dispatch = jest.fn().mockResolvedValue({ ok: true, text: 'Refunds within 30 days.' });
    const out = await runGroundingPrefetch({ ...base, turn: 'What is your refund policy?', dispatch });
    expect(dispatch).toHaveBeenCalledWith('corpus_search', 'What is your refund policy?');
    expect(out.block).toContain('Refunds within 30 days.');
  });

  it('does nothing when no rule matches', async () => {
    const dispatch = jest.fn();
    const out = await runGroundingPrefetch({ ...base, turn: 'hello', dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.block).toBeNull();
  });

  it('a FAILED prefetch is not a failed turn', async () => {
    // Failing the turn would make a latency optimisation into a new way for
    // the product to break, and the thing it optimises still works without it.
    const dispatch = jest.fn().mockRejectedValue(new Error('connector down'));
    const out = await runGroundingPrefetch({ ...base, turn: 'What is your refund policy?', dispatch });
    expect(out.block).toBeNull();
    expect(out.rule?.toolName).toBe('corpus_search');
  });

  it('a read that never answers is skipped within the deadline, not waited on', async () => {
    // It runs before the engine starts: on a dead pooled connection it used to
    // hold the opening turn for the gateway's own timer, minutes, for a read
    // the agent can still make itself.
    const dispatch = jest.fn(() => new Promise<never>(() => undefined));
    const startedAt = Date.now();
    const out = await runGroundingPrefetch({ ...base, turn: 'What is your refund policy?', dispatch, deadlineMs: 100 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(out.block).toBeNull();
    expect(out.rule?.toolName).toBe('corpus_search');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('the production deadline is short: an optional read, ahead of the engine', () => {
    expect(GROUNDING_PREFETCH_DEADLINE_MS).toBe(15_000);
  });

  it('an EMPTY result is not appended', async () => {
    // A labelled block containing nothing tells the model the help centre was
    // consulted and had no answer, which is a stronger claim than was earned.
    const dispatch = jest.fn().mockResolvedValue({ ok: true, text: '   ' });
    const out = await runGroundingPrefetch({ ...base, turn: 'What is your refund policy?', dispatch });
    expect(out.block).toBeNull();
  });
});
