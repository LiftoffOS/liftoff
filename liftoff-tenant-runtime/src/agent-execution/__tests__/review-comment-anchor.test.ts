// A finding whose line anchor GitHub refuses should still reach the human.
//
// An inline review comment can only attach to a line that appears in the diff.
// s5 emits findings with `path`, `line` and `subjectType`; when it cites a line
// it read while reasoning rather than one inside a hunk, GitHub refuses — and
// the whole finding was discarded over its coordinates, taking every other
// finding with it before the per-item loop fix.
//
// GitHub's refusal reads: "Failed to add comment to pending review.
// Possible reasons: - The line number doesn't exist in the pull request diff…"

import { isRejectedLineAnchor, toFileLevelAnchor, normalizeReviewCommentAnchor, isReviewCommentAction } from '../review-comment-anchor';

const REFUSAL =
  "Failed to add comment to pending review. Possible reasons:\n"
  + "- The line number doesn't exist in the pull request diff\n"
  + '- The file path is incorrect\n'
  + '- The side (LEFT/RIGHT) is invalid for the specified line';

const lineComment = {
  actionType: 'github-dd4c4689__add_comment_to_pending_review',
  payload: { path: 'src/a.ts', line: 42, subjectType: 'line', body: 'nit' },
};

describe('recognising a refused line anchor', () => {
  it('matches the refusal on a line-anchored review comment', () => {
    expect(isRejectedLineAnchor(lineComment, REFUSAL)).toBe(true);
  });

  it('treats an absent subjectType as a line anchor', () => {
    // `line` is what the graph sends, and it is what GitHub defaults to.
    expect(isRejectedLineAnchor(
      { ...lineComment, payload: { path: 'src/a.ts', line: 42, body: 'nit' } },
      REFUSAL,
    )).toBe(true);
  });

  it('does NOT downgrade a comment that is already file-level', () => {
    // There is nowhere further to go, and retrying identically fails twice.
    expect(isRejectedLineAnchor(
      { ...lineComment, payload: { path: 'src/a.ts', subjectType: 'file', body: 'nit' } },
      REFUSAL,
    )).toBe(false);
  });

  it('ignores an unrelated failure on the same action', () => {
    for (const err of ['Bad credentials', 'Not Found', 'rate limit exceeded', undefined]) {
      expect(isRejectedLineAnchor(lineComment, err)).toBe(false);
    }
  });

  it('ignores the refusal on a different action', () => {
    // Only a review comment has a file-level form to fall back to.
    expect(isRejectedLineAnchor(
      { actionType: 'github__merge_pull_request', payload: { line: 42 } },
      REFUSAL,
    )).toBe(false);
  });
});

describe('the file-level retry', () => {
  it('keeps the finding and drops only what was refused', () => {
    // The finding's CONTENT was never the problem — only where it was pinned.
    const next = toFileLevelAnchor(lineComment.payload);
    expect(next).toEqual({ path: 'src/a.ts', subjectType: 'file', body: 'nit' });
  });

  it('strips every line-shaped argument, in both spellings', () => {
    // Carrying a line GitHub just refused invites it to refuse the same way
    // twice.
    const next = toFileLevelAnchor({
      path: 'src/a.ts', line: 42, side: 'RIGHT', start_line: 40, startLine: 40, body: 'nit',
    });
    expect(next).not.toHaveProperty('line');
    expect(next).not.toHaveProperty('side');
    expect(next).not.toHaveProperty('start_line');
    expect(next).not.toHaveProperty('startLine');
    expect(next.body).toBe('nit');
  });

  it('does not mutate the original call', () => {
    const before = JSON.stringify(lineComment.payload);
    toFileLevelAnchor(lineComment.payload);
    expect(JSON.stringify(lineComment.payload)).toBe(before);
  });

  it('survives an absent payload', () => {
    expect(toFileLevelAnchor(undefined)).toEqual({ subjectType: 'file' });
  });
});

describe('the wiring', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('retries inside the loop, before the item is recorded as failed', () => {
    const at = SRC.indexOf('isRejectedLineAnchor(toolCall');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 2200);
    expect(block).toContain('toFileLevelAnchor(toolCall.payload)');
    // A success has to skip the failure bookkeeping entirely.
    expect(block).toMatch(/continue;/);
  });

  it('reports the DOWNGRADE failure when the retry also fails', () => {
    // So the reason reads as the anchor being unusable rather than the line
    // being wrong — two different things to go and look at.
    const at = SRC.indexOf('isRejectedLineAnchor(toolCall');
    expect(SRC.slice(at, at + 2200)).toContain('file-level retry also failed');
  });

  it('logs the downgrade rather than silently relocating the finding', () => {
    // A review that lost its line anchors should say so, not look like one that
    // never had them.
    const at = SRC.indexOf('isRejectedLineAnchor(toolCall');
    expect(SRC.slice(at, at + 2200)).toContain('attached to its file instead');
  });
});

// ── Addressing, not repair ───────────────────────────────────────────────────
//
// A finding can be lost to
// `parameter line is not a valid number: expected number, got <nil>` when the
// graph authors `subjectType: "FILE"` with `line: null` — the key present and
// empty, where GitHub requires it absent. The review then submits one finding
// lighter and reports success.
describe('normalizeReviewCommentAnchor', () => {
  it('drops the line keys for a FILE subject, matched case-insensitively', () => {
    // The model writes FILE; this module writes file. A case mismatch is not a
    // different intent, and treating it as one is what let the null through.
    const out = normalizeReviewCommentAnchor({
      path: 'docs/x.md', subjectType: 'FILE', line: null, body: 'a finding',
    });
    expect('line' in out).toBe(false);
    expect(out.subjectType).toBe('file');
    expect(out.body).toBe('a finding');
    expect(out.path).toBe('docs/x.md');
  });

  it('drops a null line even when the subject says nothing', () => {
    const out = normalizeReviewCommentAnchor({ path: 'a.ts', line: null, body: 'x' });
    expect('line' in out).toBe(false);
  });

  it('leaves a real line anchor completely alone', () => {
    const out = normalizeReviewCommentAnchor({
      path: 'a.ts', line: 42, side: 'RIGHT', body: 'x',
    });
    expect(out).toEqual({ path: 'a.ts', line: 42, side: 'RIGHT', body: 'x' });
  });

  it('does not strip nulls generally — only the anchor keys', () => {
    // A blanket null-strip would turn "clear this field" into "leave it alone"
    // on vendors that use explicit null to unset.
    const out = normalizeReviewCommentAnchor({ path: 'a.ts', line: 4, description: null });
    expect('description' in out).toBe(true);
    expect(out.description).toBeNull();
  });
});

describe('isReviewCommentAction', () => {
  it('recognises the namespaced alias the dispatcher actually sends', () => {
    expect(isReviewCommentAction('github-dd4c4689__add_comment_to_pending_review')).toBe(true);
    expect(isReviewCommentAction('add_comment_to_pending_review')).toBe(true);
    expect(isReviewCommentAction('pull_request_review_write')).toBe(false);
    expect(isReviewCommentAction(undefined)).toBe(false);
  });
});
