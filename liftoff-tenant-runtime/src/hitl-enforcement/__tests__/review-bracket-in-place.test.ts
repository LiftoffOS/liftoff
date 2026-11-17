// The review CONTAINER's lifecycle is in place; APPROVING is not.
//
// `add_comment_to_pending_review` was on the code-host allowlist from the
// start, but the two operations that OPEN and PUBLISH the review it attaches to
// were not. So the carve-out covered the middle of the review flow and neither
// end, and a reviewer gated on its very first step: pausing on
// `pull_request_review_write { method: "create", pullNumber: <n> }` for the PR
// that woke the run, having already read that PR and its diff.
//
// Adding the name alone would have been unsafe. `pull_request_review_write` is
// ONE name over five methods (create | submit_pending | delete_pending |
// resolve_thread | unresolve_thread) carrying an `event` of
// APPROVE | REQUEST_CHANGES | COMMENT. Permitting the name permits the agent to
// APPROVE the pull request that woke it, which satisfies branch protection and
// can unblock a merge — the same blast radius that killed the first draft of
// this whole carve-out (see the merge_pull_request note in in-place-reply.ts).
//
// So the name is admitted and the ARGUMENTS are interrogated.

import { isInPlaceReply } from '../in-place-reply';

const TRIGGER = {
  source: 'github',
  repository: 'acme/webapp',
  number: 42,
};

/** The call as it reached the gate in invocation fe0a1f52. */
function reviewWrite(input: Record<string, unknown>) {
  return {
    name: 'github-dd4c4689__pull_request_review_write',
    input: { owner: 'acme', repo: 'webapp', pullNumber: 42, ...input },
    categories: ['dataChanges'],
    effect: 'write' as const,
  };
}

describe('the review bracket on the triggering pull request', () => {
  it('opens a pending review in place', () => {
    // Nothing is visible on the PR until submitted, so there is no external
    // effect to bound.
    expect(isInPlaceReply(reviewWrite({ method: 'create' }), TRIGGER)).toBe(true);
  });

  it('discards its own pending review in place', () => {
    expect(isInPlaceReply(reviewWrite({ method: 'delete_pending' }), TRIGGER)).toBe(true);
  });

  it('publishes findings as COMMENT in place', () => {
    // What the distilled graph actually emits at s11:
    // toolInputTemplate {"event": "COMMENT", "body": "{{steps.s6.summary}}"}
    expect(
      isInPlaceReply(reviewWrite({ method: 'submit_pending', event: 'COMMENT' }), TRIGGER),
    ).toBe(true);
  });

  it('publishes REQUEST_CHANGES in place', () => {
    expect(
      isInPlaceReply(reviewWrite({ method: 'submit_pending', event: 'REQUEST_CHANGES' }), TRIGGER),
    ).toBe(true);
  });

  it('GATES an APPROVE — that is a merge-enabling verdict, not a finding', () => {
    expect(
      isInPlaceReply(reviewWrite({ method: 'submit_pending', event: 'APPROVE' }), TRIGGER),
    ).toBe(false);
  });

  it('GATES a submit whose event is absent rather than assuming a default', () => {
    // GitHub may default this to COMMENT. Inferring intent from a missing
    // argument is guessing, and this module resolves a near-miss to false.
    expect(isInPlaceReply(reviewWrite({ method: 'submit_pending' }), TRIGGER)).toBe(false);
  });

  it('GATES resolve_thread — dismissing a human review thread is not replying', () => {
    expect(isInPlaceReply(reviewWrite({ method: 'resolve_thread', threadId: 't1' }), TRIGGER))
      .toBe(false);
  });

  it('GATES an unrecognised or missing method', () => {
    expect(isInPlaceReply(reviewWrite({ method: 'merge' }), TRIGGER)).toBe(false);
    expect(isInPlaceReply(reviewWrite({}), TRIGGER)).toBe(false);
  });
});

describe('the identity proof still binds the bracket', () => {
  it('GATES a review opened on a DIFFERENT pull request', () => {
    const other = { ...reviewWrite({ method: 'create' }), input: {
      owner: 'acme', repo: 'webapp', pullNumber: 99, method: 'create',
    } };
    expect(isInPlaceReply(other, TRIGGER)).toBe(false);
  });

  it('GATES a review opened on a different REPOSITORY at the same number', () => {
    const other = { ...reviewWrite({ method: 'create' }), input: {
      owner: 'acme', repo: 'api', pullNumber: 42, method: 'create',
    } };
    expect(isInPlaceReply(other, TRIGGER)).toBe(false);
  });

  it('GATES when there is no trigger target at all', () => {
    expect(isInPlaceReply(reviewWrite({ method: 'create' }), undefined)).toBe(false);
  });

  it('still refuses anything tagged destructive, list or no list', () => {
    const tagged = { ...reviewWrite({ method: 'create' }), categories: ['dataChanges', 'destructive'] };
    expect(isInPlaceReply(tagged, TRIGGER)).toBe(false);
  });
});

describe('the operations that were already permitted are unchanged', () => {
  it('still allows a pending-review comment on the triggering PR', () => {
    expect(isInPlaceReply({
      name: 'github-dd4c4689__add_comment_to_pending_review',
      input: { owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'x', path: 'a.ts', subjectType: 'LINE', line: 3 },
      categories: ['dataChanges', 'customerCommunication'],
      effect: 'write',
    }, TRIGGER)).toBe(true);
  });

  it('carries no argument guard for names that do not need one', () => {
    expect(isInPlaceReply({
      name: 'github-dd4c4689__add_issue_comment',
      input: { owner: 'acme', repo: 'webapp', issue_number: 42, body: 'x' },
      categories: ['dataChanges'],
      effect: 'write',
    }, TRIGGER)).toBe(true);
  });
});
