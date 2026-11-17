// A pending review left open by a dead run must not wedge every run after it.
//
// GitHub allows one draft review per pull request per user, and the agent is one
// user. The three-op flow opens the container at `pr_review_begin` and publishes
// at `pr_review_publish`; a run that dies in between leaves it open, and nothing
// in the graph can close it. The next run's create fails permanently, takes its
// `onFailure` branch, completes "successfully" and posts nothing — forever.
//
// A run can resolve every trigger-bound step, raise nothing at the gate, and
// still die on `User can only have one pending review per pull request`, left
// behind by an earlier failed run.

import {
  isStalePendingReviewBlock,
  buildDiscardPendingReviewCall,
} from '../stale-pending-review';
import type { ToolCallRequest } from '../types';

const createCall: ToolCallRequest = {
  id: 'c1',
  connector: 'github-dd4c4689',
  entityType: 'workflow',
  actionType: 'pull_request_review_write',
  payload: { owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'create' },
};

const GITHUB_ERROR = 'User can only have one pending review per pull request';

describe('recognising the wedge', () => {
  it('matches the create blocked by a stale draft', () => {
    expect(isStalePendingReviewBlock(createCall, GITHUB_ERROR)).toBe(true);
  });

  it('matches the namespaced action name the dispatcher builds', () => {
    // The catalog registers `<alias>__<fn>`; only the bare action is the verb.
    expect(isStalePendingReviewBlock(
      { ...createCall, actionType: 'github-dd4c4689__pull_request_review_write' },
      GITHUB_ERROR,
    )).toBe(true);
  });

  it('ignores a DIFFERENT method on the same tool name', () => {
    // `pull_request_review_write` is one name over five operations. Only the
    // one that opens a container can be blocked by a container existing.
    for (const method of ['submit_pending', 'delete_pending', 'resolve_thread']) {
      expect(isStalePendingReviewBlock(
        { ...createCall, payload: { ...createCall.payload, method } },
        GITHUB_ERROR,
      )).toBe(false);
    }
  });

  it('ignores the OPPOSITE condition — a comment with no pending review', () => {
    // `add_comment_to_pending_review` fails when there is NO draft. Deleting
    // there is exactly wrong, so a loose match on "pending review" is unsafe.
    expect(isStalePendingReviewBlock(
      { actionType: 'add_comment_to_pending_review', payload: { pullNumber: 42 } },
      'There is no pending review for this pull request',
    )).toBe(false);
  });

  it('ignores an unrelated failure on the create', () => {
    for (const err of ['Not Found', 'Bad credentials', 'Resource not accessible by integration', undefined]) {
      expect(isStalePendingReviewBlock(createCall, err)).toBe(false);
    }
  });

  it('fails closed when the method is absent', () => {
    // Same rule as ARGUMENT_GUARDS: a missing method is not read as a benign
    // default, because inferring intent from an absent argument is guessing.
    expect(isStalePendingReviewBlock(
      { ...createCall, payload: { owner: 'acme', repo: 'webapp', pullNumber: 42 } },
      GITHUB_ERROR,
    )).toBe(false);
  });
});

describe('the discard call', () => {
  it('addresses the SAME pull request, copying identity rather than rebuilding it', () => {
    // The failed call's arguments were built by resolveTriggerBoundTool from the
    // event record. Rebuilding them here would be a second, independently-wrong
    // way to say which PR we mean — the reconstruction defect this codebase has
    // already paid for three times.
    const discard = buildDiscardPendingReviewCall(createCall, 'c1-discard');
    expect(discard.payload).toMatchObject({
      owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'delete_pending',
    });
    expect(discard.connector).toBe('github-dd4c4689');
    expect(discard.id).toBe('c1-discard');
  });

  it('drops arguments that belong to submit_pending', () => {
    const discard = buildDiscardPendingReviewCall(
      { ...createCall, payload: { ...createCall.payload, event: 'COMMENT', body: 'findings' } },
      'c1-discard',
    );
    expect(discard.payload).not.toHaveProperty('event');
    expect(discard.payload).not.toHaveProperty('body');
  });

  it('does not mutate the call it was built from', () => {
    const before = JSON.stringify(createCall);
    buildDiscardPendingReviewCall(createCall, 'c1-discard');
    expect(JSON.stringify(createCall)).toBe(before);
  });
});

describe('the repair is wired into the step executor', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('re-attempts without consuming a retry', () => {
    // THE subtle bug. `executeToolStep` loops `for (attempt = 1; attempt <=
    // maxAttempts; ...)` and maxAttempts DEFAULTS TO 1. A bare `continue` after
    // the discard would increment attempt to 2, fail the condition, and fall
    // out of the loop — so the slot would be freed and the review still never
    // opened, which looks identical to the bug being unfixed.
    const at = SRC.indexOf('isStalePendingReviewBlock(toolCall');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 3000);
    expect(block).toMatch(/attempt--;\s*\n\s*continue;/);
  });

  it('discards at most once per step', () => {
    // Otherwise a create that keeps failing becomes a discard/create loop
    // against the vendor.
    expect(SRC).toContain('let discardedStalePendingReview = false;');
    expect(SRC).toContain('if (!discardedStalePendingReview');
    expect(SRC).toContain('discardedStalePendingReview = true;');
  });

  it('dispatches the discard through the governed path, with no gate bypass', () => {
    // A self-healing action that exempts itself from oversight is how a
    // carve-out becomes a hole. in-place-reply.ts already permits delete_pending
    // in place ("Opening and discarding a DRAFT reach nobody"), so it does not
    // need a bypass to get through.
    const at = SRC.indexOf('isStalePendingReviewBlock(toolCall');
    const block = SRC.slice(at, at + 3000);
    expect(block).toContain('this.executeToolCalls(state, [');
    // The bypass used to be a flag and is now a grant; the discard rides neither.
    expect(block).not.toContain('bypassHitlCheck');
    expect(block).not.toContain('approvedGrant');
  });

  it('reports the DISCARD failure when the discard is what failed', () => {
    // "cannot open a review" sends whoever reads it looking at permissions,
    // when the actual state is a draft that would not go away.
    const at = SRC.indexOf('isStalePendingReviewBlock(toolCall');
    const block = SRC.slice(at, at + 3000);
    expect(block).toMatch(/could not be `?\s*\+?\s*`?discarded/);
  });
});
