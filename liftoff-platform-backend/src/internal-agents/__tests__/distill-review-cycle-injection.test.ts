import {
  shouldInjectReviewCycle,
  buildReviewCycleContractSection,
  shouldInjectIncrementalReview,
  buildIncrementalReviewSection,
  MAX_REVIEW_ROUNDS,
} from '../distill-review-cycle-injection';

describe('review-cycle contract injection (C3)', () => {
  describe('shouldInjectReviewCycle', () => {
    it('injects for a github-bound software-delivery template', () => {
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'software-engineer' })).toBe(true);
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'code-reviewer' })).toBe(true);
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'security-engineer' })).toBe(true);
    });

    it('does NOT inject when github is not bound', () => {
      expect(shouldInjectReviewCycle({ bindsGithub: false, templateId: 'software-engineer' })).toBe(false);
    });

    it('does NOT inject for a non-software-delivery template', () => {
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'customer-support' })).toBe(false);
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'sales-development' })).toBe(false);
    });

    it('does NOT inject when there is no template', () => {
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: null })).toBe(false);
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: undefined })).toBe(false);
    });
  });

  describe('buildReviewCycleContractSection', () => {
    it('returns empty string when it should not inject', () => {
      expect(buildReviewCycleContractSection({ bindsGithub: false, templateId: 'software-engineer' })).toBe('');
      expect(buildReviewCycleContractSection({ bindsGithub: true, templateId: 'customer-support' })).toBe('');
    });

    it('emits the contract with the round ceiling and reply-then-fix + attribution', () => {
      const section = buildReviewCycleContractSection({ bindsGithub: true, templateId: 'software-engineer' });
      expect(section).toContain('REVIEW-CYCLE CONVERGENCE CONTRACT');
      expect(section).toContain('Reply-then-fix');
      expect(section).toContain('notifications_send');
      expect(section).toContain(String(MAX_REVIEW_ROUNDS));
      // C1 attribution trailers.
      expect(section).toContain('— <Your Role>, Liftoff');
      expect(section).toContain('Co-authored-by: <Your Role> <your-role-slug@localhost>');
    });

    it('names the escalation recipient when one is known', () => {
      const section = buildReviewCycleContractSection({
        bindsGithub: true,
        templateId: 'software-engineer',
        escalationRecipient: 'eng-lead@acme.com',
      });
      expect(section).toContain('eng-lead@acme.com');
    });

    it('falls back to a generic recipient phrase when none is known', () => {
      const section = buildReviewCycleContractSection({
        bindsGithub: true,
        templateId: 'software-engineer',
        escalationRecipient: null,
      });
      expect(section).toContain('your escalation recipient');
      expect(section).not.toContain('()');
    });
  });

  // Rule 4 — scope a re-review to what changed, and read what was already said.
  //
  // Without it, every push made the reviewer read the whole pull request again
  // and re-derive the same findings in different words:
  // liftoff-tenant-runtime#59 took 20 inline comments over three days, six of
  // them on ONE line, none byte-identical.
  describe('the incremental-review contract', () => {
    const section = () => buildIncrementalReviewSection({ bindsGithub: true });

    // THE GATE. This is the test that was missing, and its absence is why the
    // rule shipped unable to reach its own target agent.
    //
    // The rule first lived inside the review-cycle contract, which requires a
    // software-delivery `templateId`. A templateId is only set when the agent
    // was seeded from a team preset — an agent distilled from a role
    // description has none. A code reviewer distilled from its role, bound
    // to the GitHub App and reviewing pull requests on an event trigger, has
    // `template_id = NULL`: the prompt would carry the rule and the one agent
    // it was written for could not see it.
    it('reaches a github-bound agent that has NO template', () => {
      expect(shouldInjectIncrementalReview({ bindsGithub: true })).toBe(true);
      expect(buildIncrementalReviewSection({ bindsGithub: true })).not.toBe('');
    });

    it('stays out of an agent with no github binding', () => {
      // The ops resolve against a connector that publishes PullRequest events.
      // Without one the agent could not follow the rule if it wanted to.
      expect(shouldInjectIncrementalReview({ bindsGithub: false })).toBe(false);
      expect(buildIncrementalReviewSection({ bindsGithub: false })).toBe('');
    });

    it('names its own precondition, since the binding alone does not imply reviewing', () => {
      // A github-bound agent that files issues should read one sentence and
      // move on rather than build a review workflow it was never asked for.
      expect(section()).toMatch(/REVIEWS PULL REQUESTS/);
    });

    it('does not disturb who receives the behaviour contract', () => {
      // Rules 1-3 are a deliberate audience choice. Fixing this gate must not
      // silently widen that one.
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: null })).toBe(false);
      expect(shouldInjectReviewCycle({ bindsGithub: true, templateId: 'code-reviewer' })).toBe(true);
    });

    it('names every op the rule asks for, spelled the way the runtime resolves them', () => {
      // These strings are a CROSS-REPO contract. The runtime refuses an op it
      // does not know, so a typo here produces a graph that dies at dispatch —
      // loud, but only after the agent is live. trigger-bound-ops-contract.test
      // holds the vocabulary; this holds that the prose uses it.
      for (const op of [
        'trigger__pr_get_diff_since',
        'trigger__pr_list_commits',
        'trigger__pr_list_review_threads',
        'trigger__pr_get_diff',
      ]) {
        expect(section()).toContain(op);
      }
    });

    it('branches on the action, and keeps the full diff where there is no prior review', () => {
      // On opened / reopened / ready_for_review there is nothing to build on,
      // so narrowing would review less for no benefit.
      const s = section();
      expect(s).toContain('synchronize');
      expect(s).toContain('opened');
      expect(s).toContain('reopened');
      expect(s).toContain('ready_for_review');
    });

    it('hands over the exact predicate rather than the intent', () => {
      // The runtime evaluates a step condition against `{ input: inputData,
      // steps }` and the event record IS `inputData.eventData`, so this path
      // resolves. Checked against tenant-runtime's condition.ts and
      // get-by-path.ts, not assumed.
      //
      // Worth pinning because a wrong path fails in the QUIET direction: an
      // unparseable one kills the run, but a merely wrong one reads undefined,
      // sends every event down the full-diff edge, and looks exactly like the
      // feature working.
      expect(section()).toContain("$.input.eventData.action == 'synchronize'");
    });

    it('requires the else edge, since a bare condition ends the run', () => {
      // A condition with no `onFailure` drops the cursor out of the graph. On
      // every non-synchronize event that would be the whole review.
      expect(section()).toContain('onFailure');
    });

    it('requires the commit list, so a too-narrow scope is visible', () => {
      // pr_get_diff_since returns ONE commit. A push of several is wider than
      // what gets read, and nothing in the response says so — get_commit does
      // not return `parents`. The commit list is the only way to notice.
      expect(section()).toMatch(/several commits|more than the one/);
    });

    it('carries state as the pull request own resolution flags, not as memory', () => {
      const s = section();
      expect(s).toContain('is_resolved');
      expect(s).toContain('is_outdated');
      // A private list of "what I already said" can disagree with the PR.
      expect(s).toMatch(/[Dd]o not keep your own private list/);
    });

    it('says to summarize outstanding findings rather than re-post them', () => {
      expect(section()).toMatch(/[Dd]o not re-post them/);
    });

    it('keeps the incremental ops out of the behaviour contract', () => {
      // Rule 4 moved out of that section. If it drifts back, it becomes
      // template-gated again and stops reaching template-less agents.
      expect(buildReviewCycleContractSection({ bindsGithub: true, templateId: 'code-reviewer' }))
        .not.toContain('trigger__pr_get_diff_since');
    });
  });
});
