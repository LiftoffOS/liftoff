// The trigger target is compared as SCALARS, so it must be normalized once.
//
// `isInPlaceReply` decides whether a write lands on the entity that woke the
// run by comparing `String(target.repository)` against "owner/repo" and
// `target.number` against the called pull number. A GitHub pull_request webhook
// satisfies neither shape: `repository` arrives as an OBJECT, and the number is
// nested under `pull_request.number`.
//
// So against the raw envelope the comparison is "[object Object]" versus
// "owner/repo", and undefined versus the PR number. Both fail, the identity
// proof never matches, and a review on the pull request that woke the run gates
// anyway: a reviewer agent reads the PR and its diff, writes its findings, then
// asks permission to open a draft review on that same pull request — with the
// allowlist entry for it in place.
//
// The same defect can appear in `resolve-trigger-bound-tool`, which would
// refuse `trigger__pr_get` on `repository="[object Object]"`. The readers are
// shared rather than reimplemented, so every site reads both shapes the same
// way.

import { repositorySlug, prNumber } from '../resolve-trigger-bound-tool';

/** A GitHub pull_request webhook, in the shape it actually arrives. */
const GITHUB_PUSHED = {
  repository: { full_name: 'acme/webapp', name: 'webapp' },
  pull_request: { number: 42, title: 'test' },
} as Parameters<typeof repositorySlug>[0];

/** The polled shape, where the same facts sit at the top level. */
const GITHUB_POLLED = {
  repository: 'acme/webapp',
  number: 42,
} as Parameters<typeof repositorySlug>[0];

describe('the readers handle both delivery shapes', () => {
  it('reads a repository object', () => {
    expect(repositorySlug(GITHUB_PUSHED)).toBe('acme/webapp');
  });

  it('reads a repository string', () => {
    expect(repositorySlug(GITHUB_POLLED)).toBe('acme/webapp');
  });

  it('reads a nested pull number', () => {
    expect(prNumber(GITHUB_PUSHED)).toBe(42);
  });

  it('reads a top-level number', () => {
    expect(prNumber(GITHUB_POLLED)).toBe(42);
  });

  it('answers null rather than guessing when the record carries neither', () => {
    expect(repositorySlug({} as Parameters<typeof repositorySlug>[0])).toBe('');
    expect(prNumber({} as Parameters<typeof prNumber>[0])).toBeNull();
  });
});

describe('what the gate compares against', () => {
  // The exact comparison in in-place-reply.ts, run against both shapes. A raw
  // envelope fails it; a normalized one passes.
  const called = { owner: 'acme', repo: 'webapp', pullNumber: 42 };

  function identityHolds(target: { repository?: unknown; number?: unknown }): boolean {
    const repoMatches =
      String(target.repository ?? '').toLowerCase()
      === `${called.owner}/${called.repo}`.toLowerCase();
    const numberMatches = String(target.number ?? '') === String(called.pullNumber);
    return repoMatches && numberMatches;
  }

  it('FAILS against the raw pushed envelope — this is the defect', () => {
    expect(identityHolds(GITHUB_PUSHED as never)).toBe(false);
  });

  it('holds once normalized through the shared readers', () => {
    const normalized = {
      repository: repositorySlug(GITHUB_PUSHED),
      number: prNumber(GITHUB_PUSHED),
    };
    expect(identityHolds(normalized)).toBe(true);
  });

  it('holds for the polled shape too, which already worked', () => {
    const normalized = {
      repository: repositorySlug(GITHUB_POLLED),
      number: prNumber(GITHUB_POLLED),
    };
    expect(identityHolds(normalized)).toBe(true);
  });

  it('still refuses a DIFFERENT pull request after normalization', () => {
    // Normalizing must not weaken the proof it exists to make.
    const other = {
      repository: { full_name: 'acme/webapp' },
      pull_request: { number: 99 },
    } as Parameters<typeof repositorySlug>[0];
    expect(identityHolds({
      repository: repositorySlug(other),
      number: prNumber(other),
    })).toBe(false);
  });

  it('still refuses the same number in a DIFFERENT repository', () => {
    const other = {
      repository: { full_name: 'acme/api' },
      pull_request: { number: 42 },
    } as Parameters<typeof repositorySlug>[0];
    expect(identityHolds({
      repository: repositorySlug(other),
      number: prNumber(other),
    })).toBe(false);
  });
});
