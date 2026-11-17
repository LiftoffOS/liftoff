// A reply can say it "approved the rest of the changes as good to go" while
// the review state it submitted was COMMENTED. The work is right and the
// account of it is wrong, which for the person reading is the same thing as
// the work being wrong.
//
// These pin the rendering rules. The lookup itself fails soft and is exercised
// through its caller.

import { renderActsThisRun, MAX_RENDERED_ACTS, type RecordedAct } from '../acts-this-run';

const act = (o: Partial<RecordedAct>): RecordedAct => ({
  actionType: 'pull_request_review_write',
  targetRef: 'github:acme/webapp#42',
  method: null,
  event: null,
  ...o,
});

describe('the record put in front of the model', () => {
  it('is null when the run has done nothing outward', () => {
    // Not an empty heading: a heading with no rows reads as an assertion that
    // the agent did nothing, which is a claim this has no business making.
    expect(renderActsThisRun([])).toBeNull();
  });

  it('names the submitted review STATE, which is the field that was misreported', () => {
    const out = renderActsThisRun([act({ method: 'submit_pending', event: 'COMMENT' })])!;
    expect(out).toContain('state=COMMENT');
    expect(out).toContain('method=submit_pending');
    expect(out).toContain('github:acme/webapp#42');
    // The instruction has to be explicit about the exact confusion observed.
    expect(out).toMatch(/commented on, not approved/);
  });

  it('tells the model the ledger outranks its recollection', () => {
    const out = renderActsThisRun([act({ method: 'create' })])!;
    expect(out).toMatch(/it is right and your memory is not/);
  });

  it('omits qualifiers an action does not have', () => {
    const out = renderActsThisRun([
      act({ actionType: 'add_comment_to_pending_review', targetRef: 'github:o/r#1:a.ts:4' }),
    ])!;
    expect(out).toContain('add_comment_to_pending_review on github:o/r#1:a.ts:4');
    expect(out).not.toContain('(');
  });

  it('caps the rows and STATES the overflow rather than dropping it silently', () => {
    // A reply that quietly describes 12 of 20 is the same defect one layer down.
    const many = Array.from({ length: MAX_RENDERED_ACTS + 3 }, (_, i) =>
      act({ targetRef: `github:o/r#1:f${i}.ts:1`, actionType: 'add_comment_to_pending_review' }));
    const out = renderActsThisRun(many)!;
    expect(out.match(/^- add_comment/gm)).toHaveLength(MAX_RENDERED_ACTS);
    expect(out).toContain('...and 3 more outward actions not listed here.');
  });

  it('says "action" singular when exactly one overflows', () => {
    const many = Array.from({ length: MAX_RENDERED_ACTS + 1 }, (_, i) =>
      act({ targetRef: `github:o/r#1:f${i}.ts:1` }));
    expect(renderActsThisRun(many)!).toContain('...and 1 more outward action not listed here.');
  });
});
