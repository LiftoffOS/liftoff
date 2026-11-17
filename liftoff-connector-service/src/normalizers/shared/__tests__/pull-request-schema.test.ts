// One PullRequest shape across every host that publishes one.
//
// This was two independent copies — github.ts and gitlab.ts each declared their
// own PullRequestDataSchema — and they had already drifted. Nothing failed,
// because nothing compared them. "One shape across hosts" was a convention
// maintained by hand, on precisely the contract that must not be per-host:
// subscription predicates filter on these field names, and workflow steps
// template on them.
//
// The failure mode of drift is silence. A predicate on a field one host stops
// publishing does not error — it stops matching, and a subscription that
// quietly stops firing is the hardest kind of break to find.

import { PullRequestDataSchema } from '../pull-request-schema';

// A GitLab merge request, reduced to what the normalizer actually passes.
const GITLAB_MR = {
  id: '5001',
  number: 1,
  title: 'Add retry to the poller',
  state: 'opened',
  author: 'octocat',
  authorId: 42,
  headRef: 'feat/retry',
  headSha: 'abc123',
  baseRef: 'main',
  merged: false,
  draft: false,
  repository: 'https://gitlab.com/acme/widgets',
  repositoryId: 77,
  createdAt: '2026-08-15T00:00:00Z',
  updatedAt: '2026-08-15T01:00:00Z',
};

// A GitHub pull request, including the fields only GitHub publishes.
const GITHUB_PR = {
  ...GITLAB_MR,
  state: 'open',
  author: 'octocat',
  repository: 'acme/widgets',
  action: 'synchronize',
  baseSha: 'def456',
  mergeable: true,
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  triggeredBy: 'octocat',
};

describe('the shared PullRequest schema', () => {
  it('accepts a GitLab merge request', () => {
    expect(() => PullRequestDataSchema.parse(GITLAB_MR)).not.toThrow();
  });

  it('accepts a GitHub pull request, extra fields and all', () => {
    const parsed = PullRequestDataSchema.parse(GITHUB_PR);
    expect(parsed.additions).toBe(12);
    expect(parsed.action).toBe('synchronize');
  });

  it('lets a host omit every field the other host adds', () => {
    // The drift that existed: GitHub's copy carried seven fields GitLab's did
    // not. Unifying them must not make GitLab's records fail to parse.
    const parsed = PullRequestDataSchema.parse(GITLAB_MR);
    for (const k of ['action', 'baseSha', 'mergeable', 'additions', 'deletions', 'changedFiles', 'triggeredBy'] as const) {
      expect(parsed[k]).toBeUndefined();
    }
  });

  it('still requires the fields every host must publish', () => {
    // These are the ones predicates and workflow steps rely on. If one becomes
    // optional, a host can silently stop publishing it and every predicate
    // filtering on it quietly stops matching.
    for (const required of ['id', 'number', 'title', 'state', 'author', 'authorId', 'merged', 'draft', 'createdAt', 'updatedAt']) {
      const withoutIt: Record<string, unknown> = { ...GITLAB_MR };
      delete withoutIt[required];
      expect(() => PullRequestDataSchema.parse(withoutIt)).toThrow();
    }
  });

  it('documents that `number` is only meaningful with a repository', () => {
    // A GitLab IID of 1 exists in EVERY project. A live agent run failed on
    // exactly this: it was handed {merge_request_iid: 1} with no project and
    // correctly refused, which read like the agent being unhelpful rather than
    // the payload being unusable.
    const shape = PullRequestDataSchema.shape.number.description ?? '';
    expect(shape).toMatch(/not globally unique/i);
  });

  it('warns that GitLab publishes a URL in `repository`', () => {
    // A code-review step that passes {{input.repository}} straight into GitLab's
    // project_id argument, which can never resolve.
    const shape = PullRequestDataSchema.shape.repository.description ?? '';
    expect(shape).toMatch(/web url/i);
  });
});
