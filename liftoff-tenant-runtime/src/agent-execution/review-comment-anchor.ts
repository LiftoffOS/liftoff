// A finding whose line anchor GitHub will not accept should still reach the
// human.
//
// An inline review comment can only be attached to a line that appears in the
// pull request's DIFF. A review graph's analysis step (s5) emits one finding
// per issue with `path`, `line` and `subjectType`, and a later step (s8)
// attaches each one. When the model cites a line that is not in a hunk — a line
// it read while reasoning about the file, or an off-by-one against the hunk
// header — GitHub refuses:
//
//   Failed to add comment to pending review. Possible reasons:
//   - The line number doesn't exist in the pull request diff
//   - The file path is incorrect
//   - The side (LEFT/RIGHT) is invalid for the specified line
//
// The finding itself is usually RIGHT. What is wrong is where it was pinned. So
// the whole finding was being discarded over its coordinates, and before the
// per-item loop fix it took every other finding with it.
//
// GitHub's review-comment API distinguishes a LINE comment from a FILE comment
// through `subject_type`, which the tool exposes as `subjectType` — and the
// graph already passes it per finding (`"subjectType": "{{item.subjectType}}"`),
// so the model is choosing the anchor mode for each one. A finding that cannot
// be anchored to a line can still be anchored to its FILE, which is a real
// place in the review and lands inside the same pending batch rather than as a
// loose comment somewhere else.
//
// WHY THIS DEGRADES RATHER THAN VALIDATES
//
// The obvious alternative is to check each anchor against the diff before
// dispatching. The runtime cannot do that honestly: it has no idea that some
// earlier step's output is a diff, or that this step's items are anchors into
// it. Hardcoding "look at s3" would bake one agent's graph shape into the
// shared executor, and the next graph that arranges its steps differently would
// break in a way nothing detects. Reacting to the vendor's own refusal needs no
// such knowledge and is true for any graph.
//
// A WRONG GUESS CAN ONLY HELP. If the file-level retry is refused too, the item
// fails exactly as it does today and the loop records it. Nothing is masked:
// the downgrade is logged, so a review that lost its line anchors says so.

/** GitHub's refusal for an anchor it cannot place. Matched on the stable clause
 *  rather than the whole message, which enumerates several possible causes and
 *  is the kind of text vendors reword. */
const ANCHOR_REFUSED = /line number doesn't exist|invalid for the specified line|not part of the diff/i;

/** The bare action from `<alias>__<action>`, or the name itself. */
function bareAction(name: string): string {
  const i = name.lastIndexOf('__');
  return i < 0 ? name : name.slice(i + 2);
}

/** The operations that attach a comment to a pending review. */
/** Is this call a review comment, whatever alias it arrives namespaced under?
 *  Exported so the dispatch site normalises exactly the calls this module's
 *  repair path already recognises. */
export function isReviewCommentAction(actionType: string | undefined): boolean {
  return REVIEW_COMMENT_ACTIONS.has(bareAction(actionType ?? ''));
}

const REVIEW_COMMENT_ACTIONS = new Set([
  'add_comment_to_pending_review',
  'create_pull_request_comment',
  'add_reply_to_pull_request_comment',
]);

/**
 * Is this failure a rejected LINE anchor on a review comment?
 *
 * Fail closed on every leg: a different action, an already file-level comment,
 * or a different error is not this condition. In particular a comment that is
 * already `subjectType: 'file'` must not be "downgraded" again — there is
 * nowhere further to go, and retrying identically would just fail twice.
 */
export function isRejectedLineAnchor(
  call: { actionType?: string; payload?: Record<string, unknown> },
  error: string | undefined,
): boolean {
  if (!error || !ANCHOR_REFUSED.test(error)) return false;
  if (!REVIEW_COMMENT_ACTIONS.has(bareAction(call.actionType ?? ''))) return false;
  const subject = call.payload?.subjectType;
  // Only a LINE anchor can be downgraded. An absent subjectType is treated as a
  // line anchor, because `line` is what the graph sends and what GitHub
  // defaults to.
  return typeof subject !== 'string' || subject.toLowerCase() === 'line';
}

/**
 * The same finding, anchored to its file instead of a line.
 *
 * `line` and `side` are removed rather than left in place: they are what GitHub
 * refused, and a file-level comment carrying a line it rejected invites it to
 * refuse the same way twice. Everything else — path, body — is preserved
 * exactly, because the finding's CONTENT was never the problem.
 */
export function toFileLevelAnchor(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(payload ?? {}) };
  delete next.line;
  delete next.side;
  delete next.start_line;
  delete next.startLine;
  next.subjectType = 'file';
  return next;
}

/**
 * A review comment, addressed the way the vendor accepts before it is sent.
 *
 * THE DEFECT. A finding can be lost with
 * `parameter line is not a valid number: expected number, got <nil>` when the
 * graph authors `subjectType: "FILE"` with `line: null` — a file-level comment
 * that still carries the key, set to JSON null. GitHub's tool requires `line`
 * ABSENT for a file subject, not present and empty, so the call is refused and
 * the review submits one finding lighter while reporting success.
 *
 * `toFileLevelAnchor` already encodes the right rule — a file-level comment
 * carries no line — but only as REPAIR, applied after a rejection. This applies
 * it as ADDRESSING, before the call, so the rejection does not have to happen
 * to be survived.
 *
 * Two corrections, both narrow:
 *
 *   - a FILE subject drops its line keys, matched case-insensitively because
 *     the model writes `FILE` and this module writes `file`, and a case
 *     mismatch is not a different intent;
 *   - a null `line` is dropped whatever the subject says. A null line is not a
 *     line, and sending the key asserts an anchor the payload does not have.
 *
 * Deliberately NOT a general "strip every null argument". Some vendors use an
 * explicit null to CLEAR a field, so blanket stripping would silently turn
 * "unset the description" into "leave it alone". The rule here is about one
 * argument on one family of calls, where absent and null genuinely differ.
 */
export function normalizeReviewCommentAnchor(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(payload ?? {}) };
  const subject = typeof next.subjectType === 'string' ? next.subjectType.toLowerCase() : null;

  if (subject === 'file') return toFileLevelAnchor(next);

  for (const key of ['line', 'side', 'start_line', 'startLine'] as const) {
    if (next[key] === null) delete next[key];
  }
  return next;
}
