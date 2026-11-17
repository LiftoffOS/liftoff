// "Have I reviewed PR #42" is the wrong question. "Have I reviewed PR #42 at
// head sha c6d160f7" is the right one, and `actions.target_version` is where
// the ledger keeps the answer.
//
// On its own it cannot: GitHub's `pull_request_review_write` takes
// `{method, owner, repo, pullNumber, body, event}` and has no argument for a
// commit, so the call cannot name the revision it is reviewing and neither
// can the row it writes.
//
// The revision therefore rides beside the payload, read from the run's own
// trigger record. These pin the two halves: the scoping rule that decides when
// a run HAS a revision to attribute, and the derivation that uses it without
// ever overriding a value the call itself carried.

import { triggerRevisionForConnector } from '../resolve-trigger-bound-tool';
import { deriveTarget } from '../../action-ledger/target-ref';

const SHA = 'c6d160f7a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PR = { owner: 'acme', repo: 'webapp', pullNumber: 42 };
const SYNCHRONIZE = { after: SHA, pull_request: { head: { sha: SHA } } };

describe('which runs have a revision to attribute', () => {
  it('pairs a github call with the github event that fired the run', () => {
    expect(triggerRevisionForConnector(
      { kind: 'connector_event', source: 'github' }, SYNCHRONIZE, 'github-dd4c4689',
    )).toBe(SHA);
  });

  it('does NOT stamp the head sha on a call to another connector', () => {
    // The same run posts to Slack. A head sha describes the repository that
    // fired the run and says nothing about a channel.
    expect(triggerRevisionForConnector(
      { kind: 'connector_event', source: 'github' }, SYNCHRONIZE, 'slack-d77db9a0',
    )).toBeNull();
  });

  it('says nothing for a cron or a human run', () => {
    expect(triggerRevisionForConnector({ kind: 'schedule' }, SYNCHRONIZE, 'github-1')).toBeNull();
    expect(triggerRevisionForConnector(undefined, SYNCHRONIZE, 'github-1')).toBeNull();
  });

  it('tolerates a custom_event trigger whose source is an object, not a string', () => {
    expect(triggerRevisionForConnector(
      { kind: 'custom_event', source: { sourceId: 'x', sourceName: 'y' } }, SYNCHRONIZE, 'github-1',
    )).toBeNull();
  });

  it('stays null for opened / reopened / polled records, which carry no sha', () => {
    expect(triggerRevisionForConnector(
      { kind: 'connector_event', source: 'github' }, { pull_request: { number: 42 } }, 'github-1',
    )).toBeNull();
    // A ref name is not a revision. Defaulting to the branch would record
    // whatever the tip happened to be at read time.
    expect(triggerRevisionForConnector(
      { kind: 'connector_event', source: 'github' }, { after: 'refs/heads/main' }, 'github-1',
    )).toBeNull();
  });
});

describe('the hint fills a version the call could not name', () => {
  const review = {
    connector: 'github-dd4c4689',
    actionType: 'pull_request_review_write',
    payload: { ...PR, method: 'submit_pending', event: 'COMMENT', body: 'summary' },
  };

  it('was NULL before, and is the head sha now', () => {
    expect(deriveTarget(review).version).toBeNull();
    expect(deriveTarget({ ...review, targetVersionHint: SHA }).version).toBe(SHA);
    // The target itself is unchanged — a revision is a separate dimension.
    expect(deriveTarget({ ...review, targetVersionHint: SHA }).ref)
      .toBe('github:acme/webapp#42');
  });

  it('never overrides a version the payload named', () => {
    // A value the call carries is always the truer answer.
    const withSha = { ...review, payload: { ...review.payload, commitId: 'aaaaaaa' } };
    expect(deriveTarget({ ...withSha, targetVersionHint: SHA }).version).toBe('aaaaaaa');
  });

  it('does not invent a target for a payload that names nothing', () => {
    // A revision with nothing to attach it to is not a target, and returning
    // one would make every unkeyed action in a run look like the same thing.
    const nothing = { connector: 'github-1', actionType: 'search', payload: { query: 'foo' } };
    expect(deriveTarget({ ...nothing, targetVersionHint: SHA })).toMatchObject({ ref: '', version: null });
  });

  it('ignores a blank or whitespace hint rather than storing one', () => {
    expect(deriveTarget({ ...review, targetVersionHint: '   ' }).version).toBeNull();
    expect(deriveTarget({ ...review, targetVersionHint: null }).version).toBeNull();
  });
});
