// The golden set for the skill-disclosure question.
//
// THE QUESTION. `SKILL_DISCLOSURE_MODE=disclosed` replaces each retrieved
// skill's full text in the prompt with one line — name, id, description — and a
// `read_skill(id)` tool. It is a real trade, not a free saving: tokens for a
// round trip, and a model that would have absorbed guidance passively may now
// decide it does not need to go and read it. `retrieval.ts` says exactly that,
// and says the trade is measurable on an eval set and nowhere else. This is
// that eval set.
//
// WHY THESE TASKS LOOK THE WAY THEY DO. The failure being measured is silent:
// the agent answers fluently, sounds right, and is wrong only against guidance
// it chose not to read. A task can detect that only if the guidance is
// LOAD-BEARING — if the correct answer is unreachable from the model's own
// priors and reachable only from the skill body.
//
// So each task pairs a skill whose instruction carries an ARBITRARY fact with a
// prompt whose correct answer depends on that fact. Arbitrary is the operative
// word. "Write a clear commit message" is not load-bearing; a good model writes
// one anyway and the task passes in both modes while measuring nothing. "Prefix
// every commit subject with the ticket id in square brackets" is load-bearing,
// because no prior gets you there.
//
// The description is the other half of the design, and the harder half. In
// disclosed mode the description is ALL the model sees before deciding whether
// to spend a round trip. A description that gives the answer away makes the task
// passable without reading; a description too vague to connect to the prompt
// makes the task measure retrieval, not disclosure. Each one here names the
// territory and withholds the rule — which is also what a real distilled
// description looks like, since it is generated from the skill's purpose.
//
// WHAT A RESULT MEANS.
//   inline pass, disclosed pass   — disclosure is free on this task.
//   inline pass, disclosed fail   — the cost is real: the guidance was available
//                                   and the agent did not go and read it. This
//                                   is the finding the set exists to produce.
//   inline fail                   — the TASK is broken, not the mode. The
//                                   guidance was in the prompt in full and still
//                                   did not land, so the disclosed result on
//                                   that task says nothing about disclosure.
//
// That last line is why the runner reports inline failures as task defects
// rather than as evidence against disclosure.

/** One skill seeded for the eval, in the shape `agent_skills` stores. */
export interface DisclosureEvalSkill {
  /** Stable per-task uuid so a re-run updates the row rather than duplicating
   *  it, and so a failure names the same skill across runs. */
  id: string;
  name: string;
  /** What the model sees in disclosed mode. Names the territory, withholds the
   *  rule. Also the text the retrieval embedding is generated against, so it has
   *  to read like a real description or the skill is never retrieved at all. */
  description: string;
  /** The full guidance, carrying the arbitrary fact the answer depends on. */
  instruction: string;
  tags: string[];
}

export interface DisclosureEvalTask {
  id: string;
  /** One line on what is being measured, for the report. */
  context: string;
  /** The skill that must be read for the answer to be right. */
  skill: DisclosureEvalSkill;
  /** What the eval agent is asked. Phrased as ordinary work, never as a quiz
   *  about the skill: "what does my style guide say" would prompt a read_skill
   *  call from any model and measure nothing. */
  prompt: string;

  // ── the three assertion kinds, which are not interchangeable ──────────────

  /** Strings reachable ONLY from the skill instruction. This is the measurement.
   *
   *  Structurally guarded: none of these may appear in the task's own prompt
   *  (an answer that passes by echoing the question measures nothing) and none
   *  may appear in the skill's description (the model would not need to read the
   *  body). May be empty when a skill's whole content is a prohibition — see
   *  `mustNotContain`. */
  skillEvidence: string[];
  /** Strings that must NOT appear: the plausible answer a model reaches for when
   *  it has not read the guidance. Often the stronger detector, because it
   *  catches an agent that answered from priors and sounded fine doing it. */
  mustNotContain?: string[];
  /** Proof the answer engaged with the task at all. Allowed — expected — to come
   *  from the prompt.
   *
   *  This exists because a task whose only assertions are prohibitions is passed
   *  by a refusal, an empty answer, or an error string. On a purely-negative
   *  task that hole is the whole task, so every task carries at least one of
   *  these regardless. */
  substantive: string[];

  /** Why the guidance is genuinely unreachable without reading it. Written down
   *  because "is this actually load-bearing?" decides whether the task is worth
   *  anything at all, and it is easy to get wrong months later while editing. */
  loadBearingBecause: string;
}

/** Deterministic uuids. Fixed, not generated: the eval seeds by id so a re-run
 *  updates rather than accumulates, and a report naming `skill 0a51…0003`
 *  should mean the same skill next month. */
const SKILL_ID = (n: number): string =>
  `0a51e5e0-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const DISCLOSURE_EVAL_TASKS: readonly DisclosureEvalTask[] = [
  {
    id: 'incident-severity-ladder',
    context: 'Naming a severity, where the ladder is house-specific',
    skill: {
      id: SKILL_ID(1),
      name: 'Incident severity ladder',
      description: 'How we grade incident severity and what each grade obliges.',
      instruction:
        'Our severity ladder runs S4 (lowest) to S1 (highest), which is the '
        + 'inverse of the convention most teams use.\n\n'
        + '- S4: cosmetic, no customer effect.\n'
        + '- S3: degraded for some customers, a workaround exists.\n'
        + '- S2: a customer-facing surface is unusable and there is no workaround.\n'
        + '- S1: data loss or a security exposure, whatever the blast radius.\n\n'
        + 'Every S2 and above requires a named incident commander in the first '
        + 'message. Never grade by the number of customers affected: one tenant '
        + 'losing data is S1.',
      tags: ['incident', 'oncall'],
    },
    prompt:
      'Checkout is returning 500 for every customer in one tenant and there is no '
      + 'workaround. No data has been lost. Draft the opening incident message.',
    skillEvidence: ['S2', 'incident commander'],
    // The near-universal convention is SEV1 = worst, and an outage this size
    // reads as the top of any ladder. A model answering from priors writes
    // "SEV1"/"P1" and never names a commander.
    mustNotContain: ['SEV1', 'P1'],
    substantive: ['checkout'],
    loadBearingBecause:
      'The ladder is deliberately inverted relative to the industry norm, and the '
      + 'commander obligation is house policy. Both are unreachable from priors, '
      + 'and the plausible wrong answer is exactly what a model produces without them.',
  },
  {
    id: 'refund-authority-threshold',
    context: 'A numeric threshold that decides who may act',
    skill: {
      id: SKILL_ID(2),
      name: 'Refund authority',
      description: 'Who can approve a refund, and when it has to go to someone else.',
      instruction:
        'Refunds up to 240 USD can be issued directly. Anything above 240 USD '
        + 'goes to the account owner for approval before it is promised to the '
        + 'customer — never tell a customer a refund is approved while it is '
        + 'still waiting on that approval.\n\n'
        + 'Refunds of any amount on an account less than 30 days old always go to '
        + 'the account owner, whatever the size.',
      tags: ['billing', 'support'],
    },
    prompt:
      'A customer on a two-year-old account is asking for a 310 USD refund for a '
      + 'duplicate charge. Reply to them.',
    skillEvidence: ['account owner'],
    mustNotContain: ['refund has been approved', 'approved your refund', 'issued the refund'],
    substantive: ['310'],
    loadBearingBecause:
      'The 240 USD line and the 30-day rule are arbitrary numbers. Without them a '
      + 'model either promises the refund outright or invents its own threshold, '
      + 'and both read as confident and correct.',
  },
  {
    id: 'commit-subject-format',
    context: 'A formatting rule with a specific, checkable shape',
    skill: {
      id: SKILL_ID(3),
      name: 'Commit subject format',
      description: 'The shape a commit subject line has to take in our repositories.',
      instruction:
        'A commit subject is: the ticket id in square brackets, then a space, '
        + 'then a lowercase imperative summary, and no trailing full stop.\n\n'
        + 'Example: [ENG-4417] add retry budget to the webhook dispatcher\n\n'
        + 'Do not use Conventional Commit prefixes (feat:, fix:, chore:). We drop '
        + 'them because the ticket already carries the type.',
      tags: ['engineering', 'git'],
    },
    prompt:
      'I added a retry budget to the webhook dispatcher for ticket ENG-4417. '
      + 'Give me the commit subject line.',
    skillEvidence: ['[ENG-4417]'],
    mustNotContain: ['feat:', 'fix:', 'chore:'],
    substantive: ['webhook'],
    loadBearingBecause:
      'Conventional Commits is the overwhelmingly likely default. The bracketed '
      + 'ticket prefix and the explicit ban are house rules, so the wrong answer '
      + 'is both plausible and mechanically detectable.',
  },
  {
    id: 'escalation-channel-routing',
    context: 'Routing to a named destination that cannot be guessed',
    skill: {
      id: SKILL_ID(4),
      name: 'Escalation routing',
      description: 'Where different kinds of urgent problem are supposed to go.',
      instruction:
        'Route by KIND, not by urgency:\n\n'
        + '- Anything touching customer data goes to #trust-response.\n'
        + '- Billing and invoicing goes to #revenue-ops.\n'
        + '- Everything else urgent goes to #eng-oncall.\n\n'
        + 'Never post the same escalation to more than one channel. A cross-post '
        + 'splits the response and both halves assume the other is handling it.',
      tags: ['incident', 'process'],
    },
    prompt:
      'We think a report exported one tenant\'s rows into another tenant\'s '
      + 'download. Where do I raise this, and what do I say?',
    skillEvidence: ['#trust-response'],
    mustNotContain: ['#eng-oncall'],
    substantive: ['tenant'],
    loadBearingBecause:
      'Channel names are pure convention. A cross-tenant leak also reads as '
      + 'maximally urgent, so a model without the routing rule reaches for the '
      + 'oncall channel or posts to both — the exact behaviour the skill forbids.',
  },
  {
    id: 'data-retention-window',
    context: 'A retention period, where a wrong number is a compliance answer',
    skill: {
      id: SKILL_ID(5),
      name: 'Export retention',
      description: 'How long generated exports stay available and what to tell customers.',
      instruction:
        'Generated exports are deleted 14 days after they are created. This is '
        + 'not configurable per tenant and there is no way to restore one after '
        + 'deletion — a customer who needs it again has to re-run the export.\n\n'
        + 'When a customer asks how long they have, give them the date, not the '
        + 'number of days: "available until <date>" gets acted on, "available for '
        + '14 days" does not.',
      tags: ['support', 'data'],
    },
    prompt:
      'A customer just generated a large export and asks how long they have to '
      + 'download it before it disappears. Answer them.',
    skillEvidence: ['14'],
    mustNotContain: ['30 days', '90 days', 'indefinitely', 'restore'],
    substantive: ['export'],
    loadBearingBecause:
      'Any retention window is equally plausible to a model, so it states one '
      + 'confidently. 30 and 90 days are the defaults it reaches for, and a wrong '
      + 'retention answer given to a customer is a real support defect.',
  },
  {
    id: 'meeting-notes-owner-line',
    context: 'A required structural element in an artifact',
    skill: {
      id: SKILL_ID(6),
      name: 'Meeting notes format',
      description: 'The structure our written meeting notes have to follow.',
      instruction:
        'Notes open with a line reading exactly "Decision owner: <name>" before '
        + 'anything else, even when the meeting reached no decision — in which '
        + 'case the owner is whoever will make it.\n\n'
        + 'Then: Decisions, Open questions, Next steps. Nothing else. No attendee '
        + 'list (the calendar has it) and no narrative summary of who said what.',
      tags: ['writing', 'process'],
    },
    prompt:
      'Turn this into notes: "Priya, Sam and I met about the billing migration. We '
      + 'could not agree whether to dual-write or cut over, so Priya is going to '
      + 'decide by Friday. Sam will benchmark the dual-write path first."',
    skillEvidence: ['Decision owner: Priya'],
    mustNotContain: ['Attendees'],
    substantive: ['dual-write'],
    loadBearingBecause:
      'The exact opening line is arbitrary and the no-attendee-list rule cuts '
      + 'against what every model produces for meeting notes by default. The '
      + 'required line is a composite of the skill format and a prompt name, so '
      + 'it cannot be echoed from either alone.',
  },
  {
    id: 'pricing-quote-caveat',
    context: 'A mandatory caveat the agent must not omit',
    skill: {
      id: SKILL_ID(7),
      name: 'Quoting prices',
      description: 'What has to accompany any price we put in writing to a customer.',
      instruction:
        'Every written price carries the phrase "list price, before any '
        + 'negotiated discount" alongside it. No exceptions, including customers '
        + 'who already have a discount — especially those, because a bare number '
        + 'reads to them as their number.\n\n'
        + 'Never quote an annual figure by multiplying a monthly one. Annual plans '
        + 'are priced separately and the multiplication is always wrong; ask '
        + 'before quoting one.',
      tags: ['sales', 'billing'],
    },
    prompt:
      'A prospect asked what the Growth plan costs. It is 900 USD a month. Write '
      + 'the reply, and include the annual figure.',
    skillEvidence: ['list price'],
    mustNotContain: ['10800', '10,800'],
    substantive: ['900'],
    loadBearingBecause:
      'The caveat is a specific phrase, and 900 x 12 is exactly what a model does '
      + 'when asked for the annual figure. The forbidden number is the arithmetic '
      + 'a helpful answer performs, which makes it a clean detector.',
  },
  {
    id: 'code-review-blocking-rule',
    context: 'A rule about when NOT to act',
    skill: {
      id: SKILL_ID(8),
      name: 'Review blocking rules',
      description: 'When a review comment blocks a merge and when it does not.',
      instruction:
        'Only three things block a merge: a correctness defect, a missing test '
        + 'for changed behaviour, and a security or privacy problem.\n\n'
        + 'Everything else — naming, structure, style, "I would have done this '
        + 'differently" — is a non-blocking note and must be labelled "nit:" so '
        + 'the author can ignore it without asking. A reviewer who blocks on taste '
        + 'is spending someone else\'s time on their own preference.',
      tags: ['engineering', 'review'],
    },
    prompt:
      'I am reviewing a pull request. The logic is right and it is tested, but the '
      + 'function is 200 lines long and the variable names are terse. Write my '
      + 'review comment.',
    skillEvidence: ['nit:'],
    mustNotContain: ['request changes', 'blocking', 'cannot approve'],
    substantive: ['name'],
    loadBearingBecause:
      'A model asked to review a 200-line function with terse names produces a '
      + 'change request, because that is what review training data looks like. The '
      + '"nit:" convention and the three-item blocking list are house rules.',
  },
  {
    id: 'outbound-subject-line',
    context: 'Two prohibitions in one skill, where a partial read still fails',
    skill: {
      id: SKILL_ID(9),
      name: 'Outbound email subjects',
      description: 'How we write the subject line on email that goes to a customer.',
      instruction:
        'Subjects are at most six words and never contain the customer\'s company '
        + 'name — their inbox already knows who they are, and the name burns a '
        + 'quarter of the visible line on mobile.\n\n'
        + 'Subjects never open with "Following up" or "Checking in". Lead with the '
        + 'thing itself: "Migration window: two options" beats "Following up on '
        + 'our migration conversation".',
      tags: ['sales', 'writing'],
    },
    prompt:
      'Write the subject line for an email to Northwind Trading about the two '
      + 'migration windows we discussed last week.',
    // Purely negative on purpose: this skill's whole content is two
    // prohibitions, so there is no positive string only it could produce.
    // `substantive` is what keeps a refusal from passing.
    skillEvidence: [],
    mustNotContain: ['Northwind', 'Following up', 'Checking in'],
    substantive: ['migration'],
    loadBearingBecause:
      'Naming the customer and opening with "Following up" are both what a model '
      + 'does by default for a follow-up email. Two independent rules in one skill '
      + 'means a partial read still fails, which makes this one sensitive to '
      + 'skimming rather than reading.',
  },
  {
    id: 'oncall-handover-silence',
    context: 'An instruction to withhold what the model most wants to supply',
    skill: {
      id: SKILL_ID(10),
      name: 'Oncall handover',
      description: 'What goes into a handover at the end of an oncall shift.',
      instruction:
        'A handover lists only what is OPEN. Resolved incidents do not appear, '
        + 'however much work they were — the incoming engineer cannot act on them, '
        + 'and a list of closed items buries the one thing they need.\n\n'
        + 'Each open item gets one line: what is wrong, what has been tried, and '
        + 'the single next thing to try. Never write "nothing to report" when '
        + 'there is nothing open; write "No open items", so it is clear the shift '
        + 'was checked rather than skipped.',
      tags: ['oncall', 'writing'],
    },
    prompt:
      'My shift is ending. I resolved a Redis memory alert and a flaky deploy. '
      + 'Still open: the webhook dispatcher is dropping about 2% of events, I have '
      + 'ruled out the queue, and I was about to check the retry budget. Write my '
      + 'handover.',
    // Also purely negative: "summarise only the open items" produces no string
    // the skill uniquely supplies. The forbidden strings are handed to the model
    // in the prompt, which is what makes this the most sensitive task in the set
    // — including them is the path of least resistance.
    skillEvidence: [],
    mustNotContain: ['Redis', 'flaky deploy'],
    substantive: ['retry budget'],
    loadBearingBecause:
      'Summarising the whole shift is the natural answer and the skill forbids it. '
      + 'The forbidden strings are supplied in the prompt itself, so a model that '
      + 'has not read the guidance will almost certainly include them.',
  },
] as const;

/** Every task's skill, deduplicated by id, for seeding. */
export function evalSkills(): DisclosureEvalSkill[] {
  const byId = new Map<string, DisclosureEvalSkill>();
  for (const t of DISCLOSURE_EVAL_TASKS) byId.set(t.skill.id, t.skill);
  return [...byId.values()];
}

export interface TaskVerdict {
  pass: boolean;
  /** `skillEvidence` entries that were absent — the answer did not carry the
   *  guidance. */
  missingEvidence: string[];
  /** `mustNotContain` entries that were present — the answer came from priors. */
  forbidden: string[];
  /** `substantive` entries that were absent. When this is non-empty the answer
   *  is degenerate (a refusal, an error, an empty string) and the other two
   *  columns say nothing: nothing was measured. */
  notSubstantive: string[];
}

/** Deterministic grading, on purpose.
 *
 *  A judge is the right instrument for "did this run meet the user's need",
 *  which is a matter of judgment. It is the wrong instrument here: the question
 *  is whether an arbitrary fact from a specific document reached the answer, and
 *  that is a substring, not an opinion. A judge would contribute its own
 *  variance to a measurement whose entire purpose is to compare two modes, and
 *  variance in the instrument is indistinguishable from the effect being
 *  measured.
 *
 *  Matching is case-insensitive and whitespace-collapsed, so a line break inside
 *  "Decision owner: Priya" or a bolded "**S2**" does not read as a miss. It is
 *  not fuzzy beyond that: "14" has to actually appear. */
export function gradeAnswer(task: DisclosureEvalTask, answer: string): TaskVerdict {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');
  const haystack = norm(answer);
  const has = (needle: string): boolean => haystack.includes(norm(needle));

  const missingEvidence = task.skillEvidence.filter((n) => !has(n));
  const forbidden = (task.mustNotContain ?? []).filter((n) => has(n));
  const notSubstantive = task.substantive.filter((n) => !has(n));

  return {
    pass:
      missingEvidence.length === 0
      && forbidden.length === 0
      && notSubstantive.length === 0,
    missingEvidence,
    forbidden,
    notSubstantive,
  };
}
