// Whether a working note outlives its conversation.
//
// The two rules the design rests on: nothing is ever auto-promoted, and
// promotion asks the SAME evidence question the reflection engine already asks
// rather than inventing a looser one beside it.

import {
  assessNotesForPromotion,
  runPromotionGate,
  MIN_EVIDENCE_DENSITY_FOR_PROMOTION,
} from '../conversation-promotion';
import type { Memory } from '../types';

const note = (content: string, id = `m-${Math.random().toString(36).slice(2)}`) =>
  ({ id, content } as Memory);

const GENERALIZABLE = 'The Sheets API always requires valueInputOption=USER_ENTERED or formulas are stored as text.';
const THREAD_SPECIFIC = 'The customer said they always want the report on Fridays for this ticket.';

describe('what reads as durable', () => {
  it('proposes a note that states a fact about a system', () => {
    const { candidates } = assessNotesForPromotion([note(GENERALIZABLE)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe(GENERALIZABLE);
  });

  // A note about this thread stays with this thread. Promoting a thread-scoped
  // fact turns it into advice for every future conversation.
  it('leaves a thread-specific note alone even when it also reads generally', () => {
    expect(assessNotesForPromotion([note(THREAD_SPECIFIC)]).candidates).toEqual([]);
  });

  it.each([
    'The user asked for a summary in this conversation.',
    'For this one, skip the second approval step.',
    'The requester wants it done today.',
  ])('leaves %s alone', (content) => {
    expect(assessNotesForPromotion([note(content)]).candidates).toEqual([]);
  });

  // A three-word note is a reminder to itself, and reviewing one costs a
  // person's attention for something they cannot act on.
  it('ignores a note too short to act on', () => {
    expect(assessNotesForPromotion([note('check later')]).candidates).toEqual([]);
  });

  it('ignores a long note that states nothing generalizable', () => {
    const chatty = 'I spent a while looking at the spreadsheet and then moved on to the next thing on the list.';
    expect(assessNotesForPromotion([note(chatty)]).candidates).toEqual([]);
  });

  // A run that wrote fifty notes is keeping working state, not discovering
  // fifty durable facts, and fifty candidates is how a review queue stops
  // being read.
  it('caps candidates per run', () => {
    const many = Array.from({ length: 20 }, (_, i) => note(`${GENERALIZABLE} (${i})`));
    expect(assessNotesForPromotion(many).candidates.length).toBeLessThanOrEqual(5);
  });

  // Evidence about this agent's own work supports a claim about this agent.
  // Proposing it for the whole workspace asks a reviewer to accept a much
  // larger claim on the same evidence.
  it('always proposes the individual layer, never global', () => {
    const { candidates } = assessNotesForPromotion([note(GENERALIZABLE)]);
    expect(candidates[0].proposedLayer).toBe('individual');
  });

  it('says why when it proposed nothing', () => {
    expect(assessNotesForPromotion([]).declineReason).toBe('no_notes');
    expect(assessNotesForPromotion([note('too short')]).declineReason).toBe('none_generalizable');
  });
});

describe('the gate', () => {
  const deps = (over: Partial<Parameters<typeof runPromotionGate>[1]> = {}) => ({
    evidenceDensity: jest.fn(async () => 1),
    quotaAvailable: jest.fn(async () => true),
    recordCandidate: jest.fn(async () => undefined),
    ...over,
  });

  // Rule 1, asserted directly: the gate RECORDS, and nothing in it writes a
  // memory or changes a layer.
  it('records a candidate and promotes nothing', async () => {
    const d = deps();
    const out = await runPromotionGate([note(GENERALIZABLE)], d);
    expect(out.candidates).toHaveLength(1);
    expect(d.recordCandidate).toHaveBeenCalledTimes(1);
  });

  // Rule 2: the same question the reflection engine asks, at the same
  // threshold.
  it('declines below the reflection engine\'s own evidence threshold', async () => {
    const d = deps({ evidenceDensity: jest.fn(async () => MIN_EVIDENCE_DENSITY_FOR_PROMOTION - 0.01) });
    const out = await runPromotionGate([note(GENERALIZABLE)], d);
    expect(out.declineReason).toBe('below_evidence_density');
    expect(d.recordCandidate).not.toHaveBeenCalled();
  });

  it('declines when the reflection quota is exhausted', async () => {
    const d = deps({ quotaAvailable: jest.fn(async () => false) });
    const out = await runPromotionGate([note(GENERALIZABLE)], d);
    expect(out.declineReason).toBe('quota_exhausted');
    expect(d.recordCandidate).not.toHaveBeenCalled();
  });

  // The quotas exist so the flywheel stays affordable; checking them only after
  // an expensive assessment would defeat that.
  it('checks the quota before the evidence reading', async () => {
    const order: string[] = [];
    await runPromotionGate([note(GENERALIZABLE)], deps({
      quotaAvailable: jest.fn(async () => { order.push('quota'); return true; }),
      evidenceDensity: jest.fn(async () => { order.push('density'); return 1; }),
    }));
    expect(order).toEqual(['quota', 'density']);
  });

  it('does not consult the gate at all when nothing is a candidate', async () => {
    const d = deps();
    await runPromotionGate([note('too short')], d);
    expect(d.quotaAvailable).not.toHaveBeenCalled();
    expect(d.evidenceDensity).not.toHaveBeenCalled();
  });

  // An assessment must never change the outcome of the run that produced the
  // notes.
  it('swallows a failing recorder', async () => {
    const d = deps({ recordCandidate: jest.fn(async () => { throw new Error('db down'); }) });
    await expect(runPromotionGate([note(GENERALIZABLE)], d)).resolves.toBeDefined();
  });

  it('swallows a failing quota lookup', async () => {
    const d = deps({ quotaAvailable: jest.fn(async () => { throw new Error('db down'); }) });
    await expect(runPromotionGate([note(GENERALIZABLE)], d)).resolves.toBeDefined();
  });
});
