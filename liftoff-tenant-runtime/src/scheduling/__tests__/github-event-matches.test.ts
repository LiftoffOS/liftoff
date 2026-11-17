import { githubEventMatches } from '../event-trigger';

describe('githubEventMatches', () => {
  const basePayload = {
    action: 'opened',
    pull_request: {
      number: 42,
      user: { login: 'Alex Rivera' },
      head: { ref: 'feature/foo', repo: { full_name: 'liftoff/backend' } },
      base: { ref: 'main', repo: { full_name: 'liftoff/backend' } },
      draft: false,
    },
    repository: { full_name: 'liftoff/backend' },
  };

  describe('defaults (no filter)', () => {
    it('matches a non-draft "opened" PR with no filter', () => {
      expect(githubEventMatches(undefined, basePayload)).toBe(true);
    });

    it('matches an empty filter object the same way as undefined', () => {
      expect(githubEventMatches({}, basePayload)).toBe(true);
    });

    it('rejects a draft PR by default (no opt-in)', () => {
      const draftPayload = {
        ...basePayload,
        pull_request: { ...basePayload.pull_request, draft: true },
      };
      expect(githubEventMatches(undefined, draftPayload)).toBe(false);
    });

    it('rejects a "synchronize" event by default (not in default allowedActions)', () => {
      const syncPayload = { ...basePayload, action: 'synchronize' };
      expect(githubEventMatches(undefined, syncPayload)).toBe(false);
    });

    it('rejects a "closed" event by default', () => {
      const closedPayload = { ...basePayload, action: 'closed' };
      expect(githubEventMatches(undefined, closedPayload)).toBe(false);
    });

    it('accepts a "reopened" event by default', () => {
      const reopenedPayload = { ...basePayload, action: 'reopened' };
      expect(githubEventMatches(undefined, reopenedPayload)).toBe(true);
    });

    it('accepts a "ready_for_review" event by default', () => {
      const rfrPayload = { ...basePayload, action: 'ready_for_review' };
      expect(githubEventMatches(undefined, rfrPayload)).toBe(true);
    });

    it('rejects when pull_request is missing entirely', () => {
      expect(githubEventMatches(undefined, { action: 'opened' })).toBe(false);
    });
  });

  describe('repos filter', () => {
    it('matches when repo is in the allowlist', () => {
      expect(githubEventMatches({ repos: ['liftoff/backend'] }, basePayload)).toBe(true);
    });

    it('rejects when repo is not in the allowlist', () => {
      expect(githubEventMatches({ repos: ['liftoff/frontend'] }, basePayload)).toBe(false);
    });
  });

  describe('branches filter', () => {
    it('matches when base.ref is in the allowlist', () => {
      expect(githubEventMatches({ branches: ['main'] }, basePayload)).toBe(true);
    });

    it('rejects when base.ref is not in the allowlist', () => {
      expect(githubEventMatches({ branches: ['develop'] }, basePayload)).toBe(false);
    });
  });

  describe('authors filter', () => {
    it('matches an allowed author', () => {
      expect(githubEventMatches({ authors: ['Alex Rivera'] }, basePayload)).toBe(true);
    });

    it('excludes dependabot when authors allowlist omits it', () => {
      const dependabotPayload = {
        ...basePayload,
        pull_request: { ...basePayload.pull_request, user: { login: 'dependabot[bot]' } },
      };
      expect(githubEventMatches({ authors: ['Alex Rivera'] }, dependabotPayload)).toBe(false);
    });
  });

  describe('drafts opt-in', () => {
    it('includes drafts when skipDrafts is false', () => {
      const draftPayload = {
        ...basePayload,
        pull_request: { ...basePayload.pull_request, draft: true },
      };
      expect(githubEventMatches({ skipDrafts: false }, draftPayload)).toBe(true);
    });
  });

  describe('action allowlist override', () => {
    it('allows synchronize when explicitly opted in', () => {
      const syncPayload = { ...basePayload, action: 'synchronize' };
      expect(githubEventMatches({ allowedActions: ['synchronize'] }, syncPayload)).toBe(true);
    });

    it('treats explicit empty array as "any action"', () => {
      const closedPayload = { ...basePayload, action: 'closed' };
      expect(githubEventMatches({ allowedActions: [] }, closedPayload)).toBe(true);
    });
  });

  describe('AND-composition', () => {
    it('passes when every clause matches', () => {
      expect(githubEventMatches(
        {
          repos: ['liftoff/backend'],
          branches: ['main'],
          authors: ['Alex Rivera'],
          allowedActions: ['opened'],
        },
        basePayload,
      )).toBe(true);
    });

    it('rejects when any single clause fails', () => {
      expect(githubEventMatches(
        {
          repos: ['liftoff/backend'],
          branches: ['develop'],   // doesn't match — base.ref is 'main'
        },
        basePayload,
      )).toBe(false);
    });
  });

  describe('merge trigger (requireMerged — pr.merged topic)', () => {
    const mergedPayload = {
      ...basePayload,
      action: 'closed',
      pull_request: { ...basePayload.pull_request, merged: true },
    };
    const closedUnmergedPayload = {
      ...basePayload,
      action: 'closed',
      pull_request: { ...basePayload.pull_request, merged: false },
    };

    it('matches a true merge (closed + merged) with no filter', () => {
      expect(githubEventMatches(undefined, mergedPayload, { requireMerged: true })).toBe(true);
    });

    it('rejects a closed-but-unmerged PR', () => {
      expect(githubEventMatches(undefined, closedUnmergedPayload, { requireMerged: true })).toBe(false);
    });

    it('rejects a non-close action (opened) even though it passes the default path', () => {
      expect(githubEventMatches(undefined, basePayload, { requireMerged: true })).toBe(false);
    });

    it('still narrows a merge by repo/branch/author', () => {
      expect(githubEventMatches({ repos: ['liftoff/frontend'] }, mergedPayload, { requireMerged: true })).toBe(false);
      expect(githubEventMatches({ repos: ['liftoff/backend'] }, mergedPayload, { requireMerged: true })).toBe(true);
    });

    it('does not change default behavior: a merge is still rejected WITHOUT requireMerged', () => {
      expect(githubEventMatches(undefined, mergedPayload)).toBe(false); // 'closed' not in default allowedActions
    });
  });
});
