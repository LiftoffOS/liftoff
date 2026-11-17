// Contract: the trigger-bound operation vocabulary must match tenant-runtime's.
//
// The distiller EMITS `trigger__<op>` steps; tenant-runtime RESOLVES them
// (src/agent-execution/resolve-trigger-bound-tool.ts, CANONICAL_OPS). The list
// is duplicated across the two repos rather than shared, because tenant-runtime
// pins the published @liftoffos/connector-types and a new export would need a
// package release to reach it.
//
// Duplication is only defensible if drift is caught, and this is what catches
// it. If the two lists disagree, the distiller emits a step the runtime cannot
// resolve — and the runtime refuses to guess, so the failure lands as a dead
// workflow rather than a wrong action. Loud, but still a break.
//
// Update path when adding an op: add it in BOTH files, then update the literal
// below. The literal is deliberately not imported from either side — a test
// that reads the same constant it is checking asserts nothing.

import { TRIGGER_BOUND_OPS, TRIGGER_BOUND_ENTITY } from '../distill-service';

/** Mirror of tenant-runtime's CANONICAL_OPS keys, prefixed. Hand-maintained. */
const RUNTIME_CANONICAL_OPS = [
  'trigger__pr_get',
  'trigger__pr_get_diff',
  'trigger__pr_list_comments',
  'trigger__pr_add_comment',
  // Scoping a re-review. `pr_get_diff_since` resolves to GitHub's `get_commit`
  // with `detail: full_patch` — the compare endpoint is not on the vendor's MCP
  // surface and its commits endpoint rejects a range, so one commit is the
  // narrowest reachable scope. `pr_list_commits` is what makes a scope narrower
  // than the push VISIBLE; `pr_list_review_threads` is `get_review_comments`,
  // the threads with `is_resolved` / `is_outdated`.
  'trigger__pr_get_diff_since',
  'trigger__pr_list_commits',
  'trigger__pr_list_review_threads',
  // The review flow. GitHub assembles a review as a draft and publishes it;
  // GitLab posts notes directly, so the runtime SKIPS the two bracket ops
  // there rather than refusing them.
  'trigger__pr_review_begin',
  'trigger__pr_review_comment',
  'trigger__pr_review_publish',
];

describe('trigger-bound op vocabulary matches the runtime', () => {
  it('declares exactly the ops the runtime can resolve', () => {
    expect([...TRIGGER_BOUND_OPS].sort()).toEqual([...RUNTIME_CANONICAL_OPS].sort());
  });

  it('every op uses the reserved trigger pseudo-alias', () => {
    for (const op of TRIGGER_BOUND_OPS) {
      expect(op.startsWith('trigger__')).toBe(true);
      // One `__` only: the runtime splits on the first to find the alias, and a
      // second separator would make the operation name unparseable.
      expect(op.split('__')).toHaveLength(2);
    }
  });

  it('names the POLLING entity type, not a host-specific tool tag', () => {
    // 'PullRequest' is what the event carries. The tool-level entityType tag is
    // host vocabulary ('merge_request' on GitLab) and does not join with it —
    // a mapping built on that tag looks right and matches nothing.
    expect(TRIGGER_BOUND_ENTITY).toBe('PullRequest');
  });
});
