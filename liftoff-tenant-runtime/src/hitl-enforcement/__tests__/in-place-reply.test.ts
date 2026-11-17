// The in-place reply carve-out.
//
// Most of these tests are about what must STILL gate. The carve-out is a hole
// in a security invariant by construction, so the interesting cases are the
// ones that try to widen it: a different repository, a different pull request,
// an outbound send, a destructive call, a host we cannot compare, and arguments
// that simply do not identify a record.
//
// The rule: a non-destructive, non-outbound write BACK to the entity that woke
// the run adds no blast radius, because that entity already carries the
// untrusted content. Anything else gates.

import { isInPlaceReply, type TriggerTarget } from '../in-place-reply';

const GH: TriggerTarget = {
  source: 'github',
  repository: 'acme/api',
  repositoryId: 12345,
  number: 101,
};
const GL: TriggerTarget = {
  source: 'gitlab',
  repository: 'https://gitlab.com/acme/widgets',
  repositoryId: 77,
  number: 5,
};

const comment = (input: Record<string, unknown>, categories: string[] = ['write']) =>
  ({ name: 'github-7d07a896__add_issue_comment', input, categories, effect: 'write' as const });

describe('in-place reply is allowed', () => {
  it('commenting on the GitHub pull request that woke the run', () => {
    // Tagged as the vendor classifier really tags it: add_issue_comment picks up
    // customerCommunication from the token `comment`, which a pull-request
    // comment plainly is not. A denylist on communication would have blocked the
    // exact case this carve-out exists for.
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'api', issue_number: 101, body: 'x' },
        ['dataChanges', 'customerCommunication']),
      GH,
    )).toBe(true);
  });

  it('commenting on the GitLab merge request that woke the run', () => {
    expect(isInPlaceReply(
      { name: 'gitlab-1924102e__create_merge_request_note', input: { project_id: 77, merge_request_iid: 5, body: 'x' }, categories: ['write'], effect: 'write' },
      GL,
    )).toBe(true);
  });

  it('is case-insensitive about the repository, as GitHub is', () => {
    expect(isInPlaceReply(
      comment({ owner: 'ACME', repo: 'API', issue_number: 101 }),
      GH,
    )).toBe(true);
  });
});

describe('drafting is not sending', () => {
  it('creating a draft passes on any untrusted run', () => {
    // A draft lands in the user's Drafts folder and reaches nobody until a
    // person sends it. Under communication='draft' the outbound send is not
    // registered at all and ONLY the draft form is — so gating this would mean
    // asking permission to write a draft, on every customer email.
    expect(isInPlaceReply(
      { name: 'google-mail-14a82d9e__create_draft', input: { threadId: 'abc', body: 'x' }, categories: ['dataChanges', 'customerCommunication'], effect: 'write' },
      { source: 'google_mail' },
    )).toBe(true);
  });

  it('a reply draft passes too', () => {
    expect(isInPlaceReply(
      { name: 'microsoft-outlook-mail-1__create_reply_draft', input: { messageId: 'm1' }, categories: ['dataChanges'], effect: 'write' },
      { source: 'microsoft_outlook_mail' },
    )).toBe(true);
  });

  it('but SENDING still gates', () => {
    // The whole point of the distinction: a send reaches the customer.
    expect(isInPlaceReply(
      { name: 'google-mail-14a82d9e__send_email', input: { to: 'customer@example.com' }, categories: ['dataChanges', 'customerCommunication'], effect: 'write' },
      { source: 'google_mail' },
    )).toBe(false);
  });

  it('a draft tagged outbound or destructive still gates', () => {
    expect(isInPlaceReply(
      { name: 'x__create_draft', input: {}, categories: ['outbound'], effect: 'write' },
      { source: 'google_mail' },
    )).toBe(false);
  });
});

describe('everything that widens the blast radius still gates', () => {
  it('a DIFFERENT pull request in the same repository', () => {
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'api', issue_number: 202 }),
      GH,
    )).toBe(false);
  });

  it('the same number in a DIFFERENT repository', () => {
    // PR #101 exists in many repositories; the number alone is not an identity.
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'some-other-repo', issue_number: 101 }),
      GH,
    )).toBe(false);
  });

  it('the same IID in a DIFFERENT GitLab project', () => {
    // An IID of 5 exists in every project.
    expect(isInPlaceReply(
      { name: 'gitlab-1924102e__create_merge_request_note', input: { project_id: 999, merge_request_iid: 5 }, categories: ['write'], effect: 'write' },
      GL,
    )).toBe(false);
  });

  it('an OUTBOUND send, even to the same entity', () => {
    // Publishing beyond the workspace is what the gate is really for.
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'api', issue_number: 101 }, ['write', 'outbound']),
      GH,
    )).toBe(false);
  });

  it('MERGING the pull request that woke the run', () => {
    // The case that made an allowlist necessary. `merge_pull_request`
    // tokenizes to [merge, pull, request], and `merge` is in WRITE_VERBS, NOT
    // DESTRUCTIVE_VERBS — so the vendor classifier tags it ['dataChanges'] and
    // does NOT mark it destructive. A carve-out phrased as "any non-destructive
    // write to the triggering entity" would have let an agent merge the very
    // pull request that woke it, unapproved. Tagged exactly as the classifier
    // really tags it, so this test fails if the allowlist is ever loosened.
    expect(isInPlaceReply(
      { name: 'github-7d07a896__merge_pull_request', input: { owner: 'acme', repo: 'api', pullNumber: 101 }, categories: ['dataChanges'], effect: 'write' },
      GH,
    )).toBe(false);
  });

  it('closing, labelling or assigning the triggering entity', () => {
    // None of these is a reply; all would pass a category-only check.
    for (const op of ['update_pull_request', 'add_labels', 'assign_reviewer', 'create_or_update_file']) {
      expect(isInPlaceReply(
        { name: `github-7d07a896__${op}`, input: { owner: 'acme', repo: 'api', issue_number: 101 }, categories: ['dataChanges'], effect: 'write' },
        GH,
      )).toBe(false);
    }
  });

  it('a call that identifies no record at all', () => {
    // create_repository, say — a write with no entity to be "in place" on.
    expect(isInPlaceReply(
      { name: 'github-7d07a896__create_repository', input: { name: 'new-repo' }, categories: ['write'], effect: 'write' },
      GH,
    )).toBe(false);
  });

  it('a file write that happens to carry the right number', () => {
    // No owner/repo pair means the target cannot be confirmed.
    expect(isInPlaceReply(
      { name: 'github-7d07a896__create_or_update_file', input: { number: 101, path: 'x.ts' }, categories: ['write'], effect: 'write' },
      GH,
    )).toBe(false);
  });

  it('a spawn', () => {
    expect(isInPlaceReply(
      { name: 'x__start_thing', input: { owner: 'acme', repo: 'api', issue_number: 101 }, categories: ['write'], effect: 'spawn' },
      GH,
    )).toBe(false);
  });

  it('a host this rule has not been taught to compare', () => {
    // An unconfirmed carve-out is a hole; bitbucket is not compared, so it gates.
    expect(isInPlaceReply(
      { name: 'bitbucket-cccc__add_comment', input: { issue_number: 101, owner: 'x', repo: 'y' }, categories: ['write'], effect: 'write' },
      { ...GH, source: 'bitbucket' },
    )).toBe(false);
  });

  it('a run with no trigger record', () => {
    expect(isInPlaceReply(comment({ owner: 'a', repo: 'b', issue_number: 1 }), undefined)).toBe(false);
  });

  it('a target whose number is missing', () => {
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'api', issue_number: 101 }),
      { ...GH, number: undefined },
    )).toBe(false);
  });

  it('a GitLab target with no project id', () => {
    // `repository` is the web URL there and cannot stand in for the id.
    expect(isInPlaceReply(
      { name: 'gitlab-1924102e__create_merge_request_note', input: { project_id: 77, merge_request_iid: 5 }, categories: ['write'], effect: 'write' },
      { ...GL, repositoryId: undefined },
    )).toBe(false);
  });

  it('an unclassified vendor write, even to the same entity', () => {
    // Unknown categories are not evidence of safety, and under an allowlist
    // they do not need to be: the operation is simply not a reply.
    expect(isInPlaceReply(
      { name: 'github-7d07a896__mystery_write', input: { owner: 'acme', repo: 'api', issue_number: 101 }, categories: undefined, effect: 'write' },
      GH,
    )).toBe(false);
  });

  it('a listed operation that is somehow tagged destructive', () => {
    // The allowlist narrows; a tag can still veto. It is never an override.
    expect(isInPlaceReply(
      comment({ owner: 'acme', repo: 'api', issue_number: 101 }, ['destructive']),
      GH,
    )).toBe(false);
  });
});
