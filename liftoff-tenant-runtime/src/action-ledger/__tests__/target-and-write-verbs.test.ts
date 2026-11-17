// Two defects in the ledger's keying, found by asking what the duplicate guard
// would do to a review whose findings all lost their line anchors.
//
// The guard matches (trace_id, target_ref, action_type) and runs only on
// writes. So both of these decide whether a legitimate action is refused as a
// repeat of another.

import { deriveTarget, isWriteAction } from '../target-ref';

const base = {
  connector: 'github-dd4c4689',
  actionType: 'add_comment_to_pending_review',
  entityType: 'workflow',
};
const ref = (payload: Record<string, unknown>) => deriveTarget({ ...base, payload }).ref;

const PR = { owner: 'acme', repo: 'webapp', pullNumber: 42, path: 'docs/x.md' };

describe('a file-level comment is identified by what it says', () => {
  it('keeps two different findings in one file distinct', () => {
    // THE defect. With no line there is nothing else to tell them apart, so both
    // collapsed onto `slug#number:file` and the duplicate guard refused the
    // second — two findings, one posted. Rare while only a model choosing
    // subjectType:'file' could reach it; not rare once a refused line anchor
    // falls back to file level.
    const a = ref({ ...PR, subjectType: 'file', body: 'env var name is inconsistent' });
    const b = ref({ ...PR, subjectType: 'file', body: 'this path will silently rot' });
    expect(a).not.toEqual(b);
  });

  it('still collapses two findings that say the SAME thing', () => {
    // That IS the duplicate this guard exists to stop.
    const a = ref({ ...PR, subjectType: 'file', body: 'same finding' });
    const b = ref({ ...PR, subjectType: 'file', body: 'same finding' });
    expect(a).toEqual(b);
  });

  it('keeps line-anchored comments keyed on the line, and on what they say', () => {
    // The anchor is in the payload, so it belongs in the key — and so does the
    // body, for the same reason it belongs in the file-level key. One run can
    // post several DIFFERENT findings on one line (`package-lock.json:3221`,
    // say), and the line alone would keep one.
    expect(ref({ ...PR, line: 12, body: 'x' })).toContain(':docs/x.md:12');
    expect(ref({ ...PR, line: 12, body: 'x' })).not.toEqual(ref({ ...PR, line: 40, body: 'x' }));
    expect(ref({ ...PR, line: 12, body: 'finding one' }))
      .not.toEqual(ref({ ...PR, line: 12, body: 'finding two' }));
  });

  it('still collapses two identical findings on the SAME line', () => {
    // The other half: a repeat of one finding is what the guard is for.
    expect(ref({ ...PR, line: 12, body: 'same finding' }))
      .toEqual(ref({ ...PR, line: 12, body: 'same finding' }));
  });

  it('keeps the digest out of the readable part of the ref', () => {
    // A target_ref is a key, not a copy of the comment.
    const r = ref({ ...PR, subjectType: 'file', body: 'a'.repeat(4000) });
    expect(r).toContain('github:acme/webapp#42:docs/x.md@');
    expect(r!.length).toBeLessThan(120);
  });

  it('leaves the pull-request-level target alone', () => {
    // Two PR-level summaries, however differently worded, still collide — the
    // case the original rule was written to catch.
    const a = ref({ owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'summary one' });
    const b = ref({ owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'summary two' });
    expect(a).toEqual('github:acme/webapp#42');
    expect(a).toEqual(b);
  });
});

describe('a noun is not a verb', () => {
  it('does not read `merge` inside a merge request as a write', () => {
    // THE defect. `get_merge_request` tokenizes to [get, merge, request] and came
    // back a WRITE, so the duplicate guard ran on a read and could refuse the
    // second of two identical reads in one run — against its own stated rule
    // that "a read repeated in one run is wasteful, not wrong".
    expect(isWriteAction('get_merge_request')).toBe(false);
    expect(isWriteAction('get_merge_request_diffs')).toBe(false);
    expect(isWriteAction('get_merge_request_notes')).toBe(false);
    expect(isWriteAction('list_pull_requests')).toBe(false);
  });

  it('still recognises every real write, including the ones that bury their verb', () => {
    // A pure leading-verb rule breaks these two, which is why the fix only lets
    // a leading READ verb win.
    expect(isWriteAction('pull_request_review_write')).toBe(true);   // leads with `pull`
    expect(isWriteAction('squash_and_merge_pull_request')).toBe(true); // leads with `squash`
    expect(isWriteAction('merge_pull_request')).toBe(true);
    expect(isWriteAction('add_comment_to_pending_review')).toBe(true);
    expect(isWriteAction('create_merge_request_note')).toBe(true);
    expect(isWriteAction('update_message')).toBe(true);
    expect(isWriteAction('delete_branch')).toBe(true);
  });

  it('treats an acknowledgement as the write it is', () => {
    // `mark_as_read` changes state on the far side despite naming a read.
    expect(isWriteAction('mark_as_read')).toBe(true);
  });

  it('survives an empty or malformed name', () => {
    expect(isWriteAction('')).toBe(false);
    expect(isWriteAction('__')).toBe(false);
  });
});
