# LiftoffScore: UI and data spec

Every number and sentence the panel renders, where it comes from, and which
parts do not exist yet.

Companion to the API contract in
REQUIRED_BACKEND_APIS.md. Frontend types are the
shared source of truth in [../src/types/liftoffScore.ts](../src/types/liftoffScore.ts).

---

## 1. The split this design rests on

The estimator and the interface have different jobs, and conflating them is what
made the first version unreadable.

**Attribution** is the estimator's job. A finished task involved a person and one
or more agents, and it went well or it did not. Whose contribution was that?
That needs latent variables, and a posterior mean and spread are the right tools.

**Comprehension** is the interface's job. What do I change on Monday? That needs
facts about the workspace, not parameters of a belief. `sigma = 5` is a property
of our uncertainty. "5.4 rounds of back and forth per task" is a property of the
work.

Only the second kind can be acted on. So the estimator stays server-side and
none of its own quantities reach the client: no posterior mean, no spread, no
`mu - 3*sigma`, no per-dimension sample counts. What crosses the wire is a
banded score, observable drivers, and one action.

The first version shipped `Teamwork 62 48 with a person / Results 70 61 scored`.
Four numbers, no separation, and `48 with a person` was a sample size dressed as
a score. That row is the thing this spec exists to prevent.

---

## 2. UI spec

### 2.1 Placement

A section appended to the Insights report, below the visualization blocks.
Owner and admin only. No new route, no new nav entry.

Rendered by [../src/components/Insights/LiftoffScorePanel.tsx](../src/components/Insights/LiftoffScorePanel.tsx),
fed by `useLiftoffScore`, which gates on the `liftoff_score_enabled` flag and
`canManageMembers()`. The server enforces the role independently and returns
`403` below admin. The client gate is an affordance, not a control: the payload
names people and rates them.

### 2.2 Anatomy of a row

```
│ Finance Agent            82        ✓ 9 in 10 tasks accepted first time
│ Based on 61 tasks,         Strong    ✗ Takes 2.1 rounds of back and forth per task
│ confident                            (best here: 1.2)
│                  Results strong      → Grant access to Google Sheets
│                  Teamwork good           frees ~4 hrs/month
```

| Element | Rule |
|---|---|
| Severity stripe | Left edge, coloured by band. Exists so problem rows are found by scanning, before any number is read. |
| Score | Integer 0-100. 100 means the best any teammate of this kind reaches in this workspace, not perfection. Never a decimal: the inputs are medians. |
| Band | `Strong` / `Good` / `Needs work` / `Struggling`. The band is what makes the number self-describing. A bare integer needs a legend. |
| Basis | "Based on N tasks, {confidence}". Said once per row. Never once per dimension. |
| Halves | `Results` and `Teamwork` as band words, never numbers. Reading "Results good, Teamwork needs work" is the diagnosis. Two more integers on an unexplained scale is not. |
| Drivers | 1 to 3. Each a complete sentence in units the reader already owns. Helping first, then hurting. |
| Benchmark | Optional parenthetical anchor on a driver: `(best here: 1.2)`, `(typical: 1 in 8)`. Without it a rate is uninterpretable. |
| Action | Exactly one, or an explicit "Nothing to change right now". Never two, never zero-without-saying-so. |
| Payoff | `frees ~N hrs/month`. Approximate by construction, see 5.3. |

### 2.3 Copy rules

- Never the word "agent" in rendered text (INV-UI-003). "agent", "teammate", "person".
- No em dashes (INV-UI-004).
- Drivers are sentences, not fragments, and carry a unit or a rate. "9 in 10 tasks accepted first time", not "acceptance 0.9".
- Actions are imperative and name a surface. "Loosen the approval step for routine outreach", not "consider reviewing your approval configuration".
- No invented scales beyond the one anchored score.

### 2.4 States

| Status | Renders | Trigger |
|---|---|---|
| `ok` | Groups, rows, unrated list, footnote | Workspace floor met and session graph connected |
| `too_early` | One notice, no rows | Under ~20 scored tasks, or too little overlap |
| `on_hold` | One notice, no rows | Workspace splits into groups sharing no work |
| loading | Two skeleton blocks | Request in flight |
| absent | Nothing at all | Flag off, non-admin, 403, 404, or any error |

Fail-soft is deliberate: an error renders nothing rather than a toast, matching
the intro and observations streams on the same page.

### 2.5 Refusing to rate

An entity appears with no score when any of these hold. The server sends `score`,
`band`, `resultsBand`, `teamworkBand` as `null` rather than sending numbers the
client is expected to hide.

| Reason | Meaning | Row copy |
|---|---|---|
| `too_early` | Too few tasks to be fair | "N tasks so far. About M more and we can rate them." |
| `single_partner` | Only ever worked with one counterpart, so their share is not separable from that counterpart's | "Has only worked with one teammate, so we cannot tell their part from that teammate's." |
| `no_shared_work` | Outside the connected part of the session graph | "Has not shared any work with the rest of the workspace yet." |

### 2.6 Grouping

AI kinds share one list; people have their own. There is no cross-group rank.

The additive model is identified by its priors rather than by the data, so the
level offset between two populations that rarely work within themselves comes
from the starting assumption. agents also accumulate tasks far faster than any
individual, which on a shared scale would drift them above people for a reason
unrelated to either.

### 2.7 Accessibility

- Rows are list items; groups are `section` with a heading.
- Band is conveyed by text, not only the stripe colour.
- Helping/hurting marks are `aria-hidden`; a visually hidden "Helping: " / "Hurting: " prefix carries the meaning.
- The score carries a tooltip explaining the anchor.

---

## 3. What the system actually records

Verified against the services layer. This is the ground truth every metric must
trace back to.

### 3.1 `agent_audit_logs` — one row per action

From [../src/services/activityLogs.ts](../src/services/activityLogs.ts).

| Field | Use |
|---|---|
| `action` | Which tool or action ran |
| `inputArgs`, `outputSummary` | What it was asked, what it produced |
| `outcome` | `success` / `error` / `gated` |
| `errorCode` | Failure class, which is what makes a missing-permission pattern detectable |
| `triggeredBy` | `cron`, `event:*`, `human:*`, `agent`. Separates attended from unattended work, and marks team-to-team handoffs |
| `durationMs` | Observed cost of the action. The basis of every hours estimate |
| `internalAgentId` / `externalAgentId` / `userId` | Who took part |
| `threadId` / `invocationId` | Groups actions into a task |
| `preActionSnapshot` / `postActionSnapshot` | What changed, and what a correction would revert |
| `triggeredByAgentName` | The other team, on a handoff |

### 3.2 `hitl_approvals` — one row per gate

From [../src/services/oversight.ts](../src/services/oversight.ts).

| Field | Use |
|---|---|
| `reason` | Nine `GateReason` values, so stop causes are already categorised, not inferred |
| `hitlLevel` | Severity |
| `pendingToolCalls` | Exactly what was being asked for |
| `status` | `pending` / `approved` / `rejected` / `expired`. `expired` is a gate nobody answered |
| `decision`, `rejectionReason` | Outcome and why |
| `decidedBy`, `decidedByRole` | Which person, which role |
| `createdAt` -> `decidedAt` | Human response latency |
| `expiresAt` | Deadline, so abandonment is measurable |
| `actionSummary`, `whySummary` | Runtime-generated plain-language summary |

### 3.3 Clarifications

| Field | Use |
|---|---|
| `question` | Free text. **The team's own words asking a human for something.** See 5.4 |
| `source` | `recovery_llm` / `anchor_intervention` |
| `threadId`, `createdAt`, `expiresAt` | Lets a clarification be placed relative to a failure in the same task |

### 3.4 Corrections

From [../src/services/corrections.ts](../src/services/corrections.ts). `CorrectionType`
is a closed set (`archive`, `amend`, `delete`, `refund`, `credit`, `void`,
`follow_up`, `not_correctable`) and `correctionOf` links a correction back to the
audit log it fixes. So rework is countable per team, and its kind is known.

### 3.5 Team configuration

From [../src/services/internalAgents.ts](../src/services/internalAgents.ts).
`integrations: IntegrationPermission[]` records **exactly which connectors and
which objects a team has been granted**. That is what makes "this team lacks
access to something it keeps needing" a structured comparison rather than a
guess. Also `responsibilities`, `role`, `currentVersion`, `autonomyOverride`,
`tasks30d`, `monthlyCost`.

### 3.6 Chat and live status

Messages carry `role`, `sender`, `toolCalls`, `inputTokens`, `outputTokens`,
`createdAt`, `attachments`, `citations`. Live status events are typed
`tool_call | tool_result | message_output | hitl_approval | handoff` with
`toolName` and `errorPreview`.

---

## 4. Metric catalogue

Every driver is `{metric_id, value, comparison}` on the wire. The sentence is a
template we author once, per metric. **The generator never writes English.**

That constraint is the whole defence: no hallucinated specifics, no tone drift
between rows, testable copy, translatable copy, and no way for a transcript to
steer the wording.

Availability: **A** = computable today, **B** = derivable today with work,
**C** = needs the grader or new instrumentation.

| metric_id | Template | Source | Av |
|---|---|---|---|
| `first_pass_acceptance` | "{n} in 10 tasks accepted first time" | `hitl_approvals.decision='approved'` with no `corrections` row linked | A |
| `rework_rate` | "{frac} of its work comes back for a redo" | `corrections.correctOf` -> audit logs for this team | A |
| `failure_rate` | "{n} in 10 tasks end in an error" | `audit_logs.outcome='error'` / total | A |
| `gate_stop_rate` | "Stops for approval on {n} in 10 tasks{, mostly {reason}}" | `hitl_approvals` count / tasks, grouped by `reason` | A |
| `gate_rejection_rate` | "{n} in 10 of its requests get turned down" | `decision='rejected'` / decided | A |
| `unattended_share` | "{n} in 10 tasks run with nobody watching" | `triggeredBy` in (`cron`, `event:*`) | A |
| `handoff_rate` | "Passes {n} in 10 tasks to another team" | `triggeredBy='agent'` or `handoff` events | A |
| `task_duration` | "Takes {duration} per task" | median `durationMs` per `invocationId` | A |
| `clarification_rate` | "Has to ask a question on {n} in 10 tasks" | clarifications / tasks | A |
| `blocker_lead_time` | "Flags blockers before they stall the task, {n} times in 10" | clarification `createdAt` earlier than the failing `audit_logs` row in the same `threadId` | B |
| `steering_rounds` | "Takes {n} rounds of back and forth per task" | count of `role='user'` messages per thread before completion | B |
| `missing_access` | "Blocked for want of access on {n} tasks" | `errorCode` permission class, cross-referenced against `integrations[]` | B |
| **Human side** | | | |
| `unblock_latency` | "Unblocks a waiting task in {duration}" | `createdAt` -> `decidedAt` on that person's decisions | A |
| `abandoned_gate_rate` | "{n} in 10 approval requests time out unanswered" | `status='expired'` where they were the assignee | A |
| `review_quality` | "Rarely waves through work that fails later" | approvals they approved that later got a `correction` | A |
| `brief_completeness` | "Briefs often leave out what done looks like" | grader rubric line over the opening message | C |
| **Grader-only** | | | |
| `deliverable_quality` | feeds Results, not shown as a driver | rubric over the produced artefact | C |
| `interaction_quality` | feeds Teamwork, not shown as a driver | rubric over the transcript | C |

**Most drivers need no model at all.** Twelve of the seventeen are aggregations
over tables the product already writes. That is the single most important fact in
this spec: the panel is mostly arithmetic.

Where the grader is needed it must return a **rubric line ID**, never prose.
Rubric IDs map to templates we reviewed. This is also what stops tone gaming: a
transcript rubric that scored manner rather than consequence would reward
verbosity and politeness.

---

## 5. Actions

### 5.1 A rule table, deliberately small

Fifteen or so entries, not a long tail. Each names a real screen and carries a
defensible savings formula. Vague advice is worse than none, so when nothing
matches confidently the answer is `action: null` and the row says
"Nothing to change right now".

| Trigger | Remedy | Goes to |
|---|---|---|
| `gate_stop_rate` high, `reason` mostly `level_1_gate`, `gate_rejection_rate` low | Loosen the approval step for this kind of work | `/dashboard/oversight` |
| `missing_access` present, connector absent from `integrations[]` | Grant access to {connector} | `/dashboard/connections` |
| `rework_rate` high and `CorrectionType` mostly `amend` | Add the missing context to its knowledge | `/dashboard/knowledge` |
| `steering_rounds` high and `responsibilities` spans many areas | Narrow the role, it covers {n} unrelated areas | `/dashboard/agents` |
| `failure_rate` high, one dominant `errorCode` | Fix the failing step: {errorCode} | `/dashboard/activity` |
| `handoff_rate` high with low `first_pass_acceptance` after handoff | Review the handoff, work is arriving incomplete | `/dashboard/agents` |
| `abandoned_gate_rate` high (person) | Fewer gates, or more approvers | `/dashboard/oversight` |
| `unblock_latency` high (person) | Add a second approver for this team | `/dashboard/oversight` |
| Person low, best team available | Pair with {team}, the strongest here | `/dashboard/agents` |

### 5.2 One action, chosen by expected payoff

When several rules fire, pick the one with the largest estimated hours. Ties go
to the cheaper remedy. Never render two.

### 5.3 The hours estimate

The riskiest claim on screen, so it is arithmetic over observed durations, never
a model's guess:

```
hours_per_month = (metric - benchmark) * observed_unit_cost * tasks_per_month
```

Worked, for a team stopping at a gate on 7 in 10 tasks against a typical 2 in 10,
34 tasks a month, median `createdAt -> decidedAt` of 4.2 hours of wall-clock
delay of which ~40 minutes is attributable human handling time:

```
(0.7 - 0.2) * 34 * 40min = 11.3 hours/month  ->  displayed as "frees ~9 hrs/month"
```

Every term comes from the audit log or the approvals table. Rules:

- Always prefix `~`. The inputs are medians.
- Round to whole hours above 10, one decimal below.
- Suppress the payoff entirely when `tasks_per_month < 10`. The estimate would be noise.
- The arithmetic must be available on hover. A number nobody can check is a number nobody should trust.

### 5.4 Quote the evidence, do not paraphrase it

This corrects a real mistake in the first draft.

The mock said **"Connect the billing sheet it keeps working around"**. That is
not derivable. "Billing sheet" is a resource name that exists only inside the
free text of a clarification question or inside `inputArgs`, and turning it into
that phrase needs entity extraction plus a guess about intent. It reads
convincingly and it is fabrication.

Two things are structured and true:

1. The **connector** is structured. `integrations[]` says what a team has; the
   connector catalogue says what exists. "Grant access to Google Sheets" is a
   fact.
2. The team's **own words** are structured, as a stored string. Clarification
   `question` text can be quoted verbatim.

So the row should read:

```
→ Grant access to Google Sheets                   frees ~4 hrs/month
   It asked 6 times: "Share the billing sheet with the service
   account so I can write to it."
```

Better on every axis. Traceable to a row in the database, unfabricated, and far
more persuasive than our paraphrase, because it is the team saying what it needs.

**Rule: name the structured thing, quote the unstructured thing, never paraphrase
the unstructured thing.**

---

## 6. What does not exist yet

| Gap | Needed for | Cost |
|---|---|---|
| Turn counting per invocation | `steering_rounds` | Derivable from chat messages if threads map cleanly to invocations. Confirm that mapping first |
| Error-code taxonomy for permission failures | `missing_access` | `errorCode` exists but is not classified. Needs a lookup table |
| Grader pipeline | Results, Teamwork, `brief_completeness` | The real cost. Rubric generation plus N>=2 independent graders per task |
| Responsibility-area count | "covers {n} unrelated areas" | `responsibilities` is free text. Needs a classifier or a structured field at team-build time |
| Attributable handling time | The hours estimate | `decidedAt - createdAt` is wall clock, not human effort. Needs either a sampled study or a conservative fixed assumption, stated openly |

---

## 7. Open risks

**Score and drivers use different machinery.** The score comes from the joint
model; drivers are per-entity aggregates. So a driver is not attributed the way
the score is. A team can look like it needs heavy steering when one person
over-steers everything. Mitigation: compute drivers only over that entity's own
tasks and always show the benchmark. The seam is real.

**The rule table encodes our assumptions.** "High approval stops means loosen the
gates" is usually right and sometimes exactly wrong. Treat every action as a
hypothesis until the improvement loop has evidence on which remedies actually
moved a score.

**Naming a person's weakness is harsher than naming a team's.** "Briefs often
leave out what done looks like" is true, useful, actionable, and also a sentence
about a named employee on a screen their manager reads. Templates for the
`person` group need a different editorial standard, reviewed by someone other
than the author.

**The hours figure will be quoted back at us.** It is the number most likely to
end up in a slide. Conservative inputs, a visible `~`, and checkable arithmetic
are the whole defence.
