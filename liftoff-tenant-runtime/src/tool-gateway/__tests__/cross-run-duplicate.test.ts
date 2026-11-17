// The same thing, at the same revision, acted on twice in two different runs.
//
// The run-scoped guard was justified as "conflating them would block
// tomorrow's legitimate review of the same pull request". That is true of the
// ENTITY and false of the entity AT A REVISION: new commits are a new head
// sha, so tomorrow's review carries a different key and was never at risk.
//
// The cross-run half exists because the alternative did not work. Asking
// "have I ever done this" is have_i_acted_on's job and the agent has to choose
// to ask, and agents do not — not even one whose graph carries the step, when
// its engine never runs the graph.

import { deriveTarget } from '../../action-ledger/target-ref';

describe('what the cross-run guard can and cannot key on', () => {
  const pr = (sha: string) => deriveTarget({
    connector: 'github',
    actionType: 'pull_request_review_write',
    payload: { owner: 'acme', repo: 'webapp', pull_number: 42, body: 'looks good' },
    targetVersionHint: sha,
  });

  it('gives the same key to two reviews of one pull request at one head', () => {
    // The case that must be refused. Two reviews of the same commit are two
    // sets of comments on work already reviewed.
    const first = pr('a450b99');
    const second = pr('a450b99');
    expect(second.ref).toBe(first.ref);
    expect(second.version).toBe(first.version);
    expect(first.version).toBeTruthy();
  });

  it('gives a DIFFERENT key once new commits land', () => {
    // The case that must be allowed, and the objection the run scope was
    // defending against. A push moves the head, so the key moves with it.
    const before = pr('a450b99');
    const after = pr('c71f204');
    expect(after.ref).toBe(before.ref);
    expect(after.version).not.toBe(before.version);
  });

  it('leaves an unversioned target alone', () => {
    // A weekly digest posted to the same channel every Monday names no
    // revision. Refusing the second would break a working agent to prevent
    // nothing, so the guard requires a version and this target has none.
    const post = deriveTarget({
      connector: 'slack',
      actionType: 'send_message',
      payload: { channel: 'C123', text: 'Monday digest' },
    });
    expect(post.version).toBeNull();
  });

  it('leaves a created document alone, which is why the block lists them instead', () => {
    // A create names no revision either, so repeats of THAT shape are addressed
    // where they can be seen rather than where they are indistinguishable from
    // correct work: prior-work lists what the agent already produced, by name,
    // before it decides to produce it again.
    const doc = deriveTarget({
      connector: 'google-docs-8fd9fc68',
      actionType: 'create_document_markdown',
      payload: { title: 'Acme — Competitive Digest 2026-09-03' },
    });
    expect(doc.version).toBeNull();
  });
});
