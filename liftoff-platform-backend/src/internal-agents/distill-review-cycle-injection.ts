// Review-cycle convergence contract, injected at distill time for software-delivery-family
// agents that bind github. This is the AGENT-INSTRUCTION-level convergence nudge (reply then
// fix per comment; bounded rounds then escalate + stop); the reactive-subscriptions
// count-and-cap loop guard (tenant-runtime) is the INFRASTRUCTURE-level backstop.
//
// Rule 4 is a GRAPH-SHAPE rule rather than a behaviour nudge, which is why it names tools.
// It is here and not in the main prompt because this section is already scoped to exactly
// the agents it applies to — software-delivery roles that bind github — and this prompt is
// the one that produces the workflow, so the rule lands where the graph is authored.
//
// What it fixes: a re-review re-read the whole pull request and re-derived the same findings
// in different words. liftoff-tenant-runtime#59 collected 20 inline comments over three days,
// six of them on ONE line, and NONE byte-identical — which is why the answer is to narrow
// what the agent looks at and let it see what it already said, rather than to compare texts.
// The two halves are separate on purpose: scoping makes a repeat finding structurally
// impossible on code that was not re-read, and the thread state covers everything else.
//
// Structure mirrors distill-work-inbox-injection.ts: a pure predicate + a section builder,
// so the caller can concatenate the returned string unconditionally.

// The software-delivery team roles this contract applies to.
const SOFTWARE_DELIVERY_TEMPLATES = new Set([
  'software-engineer',
  'code-reviewer',
  'security-engineer',
  'performance-engineer',
  'incident-manager',
]);

// Max review rounds on ONE pull request before escalating and stopping. A constant here
// (observed median + buffer from the software-delivery fixture runs); a policy floor, not a
// distribution — not auto-calibrated.
export const MAX_REVIEW_ROUNDS = 4;

/** True when the review-cycle contract should be injected: a github-bound agent whose template
 *  is in the software-delivery family. */
export function shouldInjectReviewCycle(opts: { bindsGithub: boolean; templateId?: string | null }): boolean {
  return opts.bindsGithub && !!opts.templateId && SOFTWARE_DELIVERY_TEMPLATES.has(opts.templateId);
}

/** Build the injected section. Returns '' when it should not be injected, so the caller can
 *  concatenate safely. `escalationRecipient` (if known) is named in the escalation step. */
export function buildReviewCycleContractSection(opts: {
  bindsGithub: boolean;
  templateId?: string | null;
  escalationRecipient?: string | null;
}): string {
  if (!shouldInjectReviewCycle(opts)) return '';
  const recipient = opts.escalationRecipient
    ? `your escalation recipient (${opts.escalationRecipient})`
    : 'your escalation recipient';

  return `
REVIEW-CYCLE CONVERGENCE CONTRACT (platform-enforced):

You work pull requests to convergence, not indefinitely. On every review round for a PR:

1. Reply-then-fix, per comment. Before changing any code in response to a review comment, post a reply stating your intended action (accept, clarify, or push back with rationale). Then make the change. Close each thread you opened once the fix lands.
2. Bounded rounds. Track the review rounds you have taken on a single PR. After ${MAX_REVIEW_ROUNDS} rounds on the SAME pull request without the review converging (threads still unresolved, checks still red), STOP working that PR: send a notification via \`notifications_send\` to ${recipient} summarizing what is blocking convergence, and do not open another round on it. Do not spin.
3. Attribution. Sign every review and comment you post with your role trailer ("— <Your Role>, Liftoff"). End every commit message you author with "Co-authored-by: <Your Role> <your-role-slug@localhost>".
`;
}

/** True when the incremental-review contract should be injected.
 *
 *  Gated on the GITHUB BINDING ALONE, deliberately — NOT on the template.
 *
 *  `shouldInjectReviewCycle` above requires a software-delivery templateId, and
 *  a `templateId` is only set when the agent was seeded from a team preset. An
 *  agent distilled from a role description has none. The live dev Code
 *  Reviewer — the agent this whole contract was written for, bound to the
 *  GitHub App, reviewing pull requests on an event trigger — has
 *  `template_id = NULL`, so a template-gated rule reaches it never.
 *
 *  That is the wired-at-one-end shape: the rule exists, the tests pass, the
 *  prompt carries it, and the one agent it was written for cannot see it.
 *
 *  A binding is the right precondition here anyway. What makes this rule apply
 *  is what the agent is WIRED TO, not which preset created it: the ops it names
 *  resolve against a connector that publishes PullRequest events, so an agent
 *  without that binding could not follow the rule if it wanted to. The prose
 *  opens by naming its own precondition, so a github-bound agent that does not
 *  review pull requests reads one sentence and moves on.
 *
 *  Left as a separate predicate rather than widening the one above, because
 *  rules 1-3 are a behaviour contract (reply-then-fix, bounded rounds,
 *  attribution trailers) whose audience is a deliberate choice someone made.
 *  Widening that silently is a different decision from fixing this. */
export function shouldInjectIncrementalReview(opts: { bindsGithub: boolean }): boolean {
  return opts.bindsGithub;
}

/** Build the incremental-review section. Empty string when not applicable, so
 *  the caller can concatenate unconditionally. */
export function buildIncrementalReviewSection(opts: { bindsGithub: boolean }): string {
  if (!shouldInjectIncrementalReview(opts)) return '';

  return `
INCREMENTAL REVIEW CONTRACT (platform-enforced):

This applies if this agent REVIEWS PULL REQUESTS on a connector event trigger. If it does not, skip this section.

A pull request you have reviewed before is not a pull request you review again from scratch. Reviewing the whole thing on every push makes you re-derive findings you already posted and word them differently, which reads as a new finding and is not one. Build the workflow so that:

1. The step that reads the diff BRANCHES on the triggering event's \`action\`. The predicate is \`$.input.eventData.action == 'synchronize'\` — use it exactly; \`eventData\` is the webhook body the event carried and \`action\` is a field on it. Put that condition on a \`trigger__pr_get_diff_since\` step (the commit that was just pushed) and give it an \`onFailure\` edge to a \`trigger__pr_get_diff\` step (the whole pull request). "synchronize" means someone pushed to a PR that already exists; on "opened", "reopened" and "ready_for_review" there is no previous review to build on, so the whole diff is the right scope and narrowing would only review less for no benefit. A condition with no \`onFailure\` would end the run on every non-synchronize event, so both edges are required.
2. On the "synchronize" branch, also call \`trigger__pr_list_commits\`. \`trigger__pr_get_diff_since\` returns ONE commit, so when a push carried several commits it is narrower than the push. The commit list is how you find that out. If the commits added since your last review are more than the one you read, say so in your review summary and read the full diff instead — a review that quietly covered less than it appeared to is worse than one that cost more.
3. On EVERY branch, call \`trigger__pr_list_review_threads\` before you analyse anything, and pass the result into the analysis. It returns the review threads already on this pull request, each with \`is_resolved\` and \`is_outdated\`.
4. Do not raise a finding that an unresolved thread already makes. Those two flags are the pull request's own state and they are the only state you need: \`is_resolved\` false means the point still stands and nobody has dealt with it, so repeating it adds noise and no information. \`is_outdated\` true means the code it was anchored to has since changed, so re-check it against the new code before deciding it still applies. Do not keep your own private list of what you have already said — it will disagree with what the pull request actually shows.
5. If unresolved findings from earlier rounds remain, note that once, in the review summary, with a count. Do not re-post them as new line comments.
`;
}
