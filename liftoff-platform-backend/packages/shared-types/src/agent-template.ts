/**
 * Agent Template types — shared across platform-backend, tenant-runtime, and liftoff-react.
 * Schema version bump required for breaking changes.
 */

export const AGENT_TEMPLATE_SCHEMA_VERSION = 2 as const;

export type DepartmentCategory =
  | 'customer_support'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'hr'
  | 'legal'
  | 'operations'
  | 'engineering'
  | 'other';

// Exactly one of connectorType or capability must be set (enforced at runtime by Zod).
// - connectorType: requires a specific connector (e.g., 'slack', 'github')
// - capability: accepts any connector that satisfies the functional group
//   (e.g., 'email_marketing' → mailchimp, sendgrid, hubspot)
//   Scopes are determined by the capability registry, not the template YAML.
/** A concrete thing inside the customer's own workspace that a requirement
 *  needs named: which channel to post to, which folder to write into, which
 *  list to read from.
 *
 *  A PICK NAMES WHERE OUTPUT GOES. NOTHING ELSE.
 *  The team cannot guess which channel to post in or which folder to write to,
 *  so those are worth one question each. Everything it needs to READ is its own
 *  job, and asking about it is how a hire flow turns into a setup form:
 *
 *    - Something the team produces and re-reads (a watch list, a backlog, a
 *      register) does not pre-exist. Requiring the customer to supply one asks
 *      them to do the team's job before it starts, and blocks anyone who has
 *      never written it down. Create it in the folder you were given, seed it
 *      only from connected sources, and read it back each run. They correct it
 *      in their own document, which beats any loop that leads back here.
 *
 *    - Something the company already owns (positioning, brand guidelines, a
 *      price book) is reachable through the connector that is already bound.
 *      Search for it, name in the output which document was used so it can be
 *      corrected, and say plainly when nothing was found. A `read` object buys
 *      exactness at the cost of a question, and gets nothing the team could not
 *      have found for itself.
 *
 *  In practice `direction: 'read'` should be rare and well argued. If a
 *  template declares one, the first question is why the team cannot find it.
 *
 *  This exists because connecting a tool is not the same as knowing where to
 *  put things. A template that says "post the alert to the finance channel"
 *  compiles into an agent with no channel, and the person is never asked which
 *  one. Binding Slack does not answer the question; it only makes the question
 *  answerable.
 *
 *  `kind` selects the enumerator that browses the customer's workspace for
 *  candidates. Adding a new kind is a registry entry on both sides, not a new
 *  flow, which is what keeps this scalable across the catalog.
 *
 *  Objects on a REQUIRED connector gate the hire the same way the connection
 *  itself does; objects on an optional connector are asked only if that
 *  connector is actually connected. */
export interface RequirementObject {
  /** Stable id, unique within its requirement. */
  id: string;
  /** Declares that the platform can supply this destination when no connector
   *  does, so the sentence naming it stays true unbound. */
  whenUnbound?: 'platform_chat';
  kind: 'folder' | 'file' | 'channel' | 'table';
  /** `write` is a destination the team produces into; `read` is an input it
   *  consumes. They ask visibly different questions, so the UI needs to know
   *  which one it is asking. */
  direction: 'read' | 'write';
  /** The question as the person reads it, e.g. "Where should the competitive
   *  digest live?". Shown in the picker and on the connector row. */
  label: string;
  /** Whether an unanswered pick blocks Continue on the connectors step.
   *
   *  Almost always `false`, and nothing in the catalog sets it true. The step
   *  gates on CONNECTIONS: a team needs its tools to work, and a destination is
   *  not a tool. A folder the team writes into is one it can create and report;
   *  a channel it can post to and name in its output; a document it can make.
   *  None of them is a fact a person must supply before hiring, and asking for
   *  one as a precondition turns "where would you like this" into "answer this
   *  or you may not proceed".
   *
   *  Reserve `true` for a pick without which the work cannot begin at all and
   *  which the team cannot create for itself. If a fallback phrase reads
   *  sensibly in the prose, the answer is `false`. The validator additionally
   *  forbids `true` on an optional connector, which can never make anything
   *  mandatory. */
  required: boolean;
  /** What the sentence says when this pick has no answer yet. A short noun
   *  phrase that reads naturally where `{{pick:<id>}}` appears in the prose:
   *  "your team channel", "the folder they work in".
   *
   *  It does two jobs, and they are the same job. On the template detail page
   *  nobody has picked anything, so the placeholder renders as this phrase and
   *  a person reads "Post the summary to your team channel". At hire time an
   *  unanswered optional pick substitutes to it too, because the alternative is
   *  an empty string and a system prompt that says "Post the summary to ."
   *
   *  Required on any object whose id appears in the template's prose, which
   *  the validator checks. */
  fallback?: string;
}

/** One fact the template needs and cannot know: asked on the connectors step,
 *  substituted into the template's prose as `{{id}}`, and passed to the
 *  distiller. See AgentTemplate.inputs. */
export interface TemplateInput {
  /** Referenced in template prose as `{{id}}`. Snake case by convention, so a
   *  placeholder reads as a placeholder: `{{company_name}}`. */
  id: string;
  /** The field label. A question the person can answer without knowing how we
   *  work: "Company name", not "Tenant identifier". */
  label: string;
  /** `text` is a single line; `url` differs only in the keyboard and
   *  autocomplete a browser offers. Both arrive as strings. */
  type: 'text' | 'url';
  /** A required input blocks Continue. Reserve it for facts the team is wrong
   *  without: if the work merely improves with it, leave it optional rather
   *  than standing between a person and a hire. */
  required: boolean;
  /** Shown greyed inside the empty field. An example, never an instruction. */
  placeholder?: string;
  /** One line under the field, for when the label alone leaves a person
   *  guessing WHY it is being asked. */
  hint?: string;
  /** The phrase the placeholder reads as when the input was left blank. Only
   *  an optional input can be blank, and the alternative is an empty string
   *  in the middle of a sentence: "argue from what  says". The same rule as an
   *  object's fallback, for the same reason.
   *
   *  Required on any optional input whose id appears in the template's prose,
   *  which the validator checks. */
  fallback?: string;
}

export interface ConnectorRequirement {
  id: string;             // stable ID for connectorMapping reference
  connectorType?: string; // specific connector type — matches ConnectorType enum
  capability?: string;    // functional capability group — matched against CONNECTOR_CAPABILITIES
  /** Several capability groups, ANY ONE of which satisfies the requirement.
   *
   *  One capability per requirement, gated with AND across requirements, is
   *  right whenever the team needs both things. It is wrong whenever the same
   *  work arrives by two routes: a contract reaches a workspace as a Drive file
   *  or as a Notion page, and the team that reads it does not care which. Under
   *  the single-capability rule the legal templates all required
   *  `cloud_storage`, so a workspace that keeps its documents in Notion or
   *  Google Docs could not hire any of them, and the alternative — one template
   *  per storage family — multiplies the catalog by the number of vendors.
   *
   *  Exactly one of `connectorType`, `capability` and `capabilities` is set;
   *  the validator enforces that, and that a list carries at least two entries
   *  (one is `capability`, written the shorter way). */
  capabilities?: string[];
  role: 'data_source' | 'tool';
  requiredScopes: string[];
  description: string;
  /** Things inside the customer's workspace this requirement needs named.
   *  Absent for the majority of requirements: a pure `data_source` the team
   *  reads through the connector needs nothing picked. */
  objects?: RequirementObject[];
  /** The two ways a sentence reads, depending on whether this OPTIONAL
   *  connector was actually bound at hire.
   *
   *  A template used to carry the connected version in the workflow and the
   *  unconnected version in an edge case, and the hired agent got both — an
   *  instruction to post to a channel, and a paragraph explaining what to do
   *  when there is no channel. We know at hire time which it is, so the agent
   *  should get one sentence and no branch.
   *
   *  The prose references this as `{{connector:<requirement id>}}`. Bound, that
   *  resolves to `whenBound` (whose own `{{pick:...}}` then resolves to the
   *  destination the person named). Unbound, it resolves to `whenUnbound`,
   *  which must not mention the connector at all: the point is a sentence
   *  written as though that tool was never part of the job, not a apology for
   *  its absence.
   *
   *  Both are CLAUSES, not whole sentences, so they can sit inside a numbered
   *  step: "…file it back where it came from, and {{connector:opt-team-chat}}."
   *
   *  ONLY for absence that changes WHERE OUTPUT GOES. Where absence changes
   *  what work happens — reading invoices from a CRM versus handing the ticket
   *  to a person — the branch is real and belongs in Edge cases as prose, since
   *  expressing it here would mean maintaining two workflows that drift. */
  prose?: {
    whenBound: string;
    whenUnbound: string;
  };
}

export type ExtractionColumnFormat =
  | 'text'
  | 'bulleted_list'
  | 'date'
  | 'yes_no'
  | 'monetary_amount'
  | 'percentage'
  | 'currency'
  | 'tag'
  | 'number';

export interface ExtractionColumn {
  index: number;
  name: string;
  prompt: string;
  format?: ExtractionColumnFormat;
  tags?: string[];
}

export interface AgentTemplate {
  id: string;
  version: string;
  displayName: string;
  departmentCategory: DepartmentCategory;
  description: string;
  roleSummary: string;   // 1-2 sentence summary of the agent's role — used in workforce plan specs

  // These pre-fill the TeamBuilder form — passed to distillation as the user input.
  // Distillation runs exactly as it would for a manually-entered role.
  role: string;               // SHORT job title: "Sales Development Representative"
                              // NOT a sentence. Matches how users name roles in TeamBuilder.
  responsibilities: string;   // Multi-section markdown block:
                              //   ## Responsibilities
                              //   ## Goals
                              //   ## Workflows
                              //   ## Instructions
                              //   ## Outcomes
  additionalContext: string;  // Multi-section markdown block:
                              //   ## Specific instructions
                              //   ## Rules
                              //   ## Constraints
                              //   ## Edge cases
                              //   ## Anything to avoid

  requiredConnectors: ConnectorRequirement[];
  optionalConnectors: ConnectorRequirement[];

  /** Facts the template cannot supply and the platform must not guess.
   *
   *  These began life as skills a person edited by hand: where a template says
   *  "our competitors", the customer typed who "our" meant before running it.
   *  Both of our flows removed that step and put nothing back, so a competitive
   *  intelligence analyst went to work without knowing whose competitors it was
   *  tracking, and a comparison writer argued a side belonging to nobody.
   *
   *  Collected on the connectors step, the last screen before distillation, and
   *  never inferred from a workspace name, a sign-in domain or a connected
   *  account. Each of those is plausible and wrong often enough to point a year
   *  of research at the wrong company, and wrong is invisible here: every output
   *  still looks well-formed.
   *
   *  Deliberately a LIST rather than named fields. Company is simply the first
   *  thing templates needed; a target market, a price floor or a reporting
   *  cadence are the same kind of gap, and declaring one should never require
   *  touching the UI. Values are substituted into the template's own prose
   *  wherever `{{id}}` appears, and handed to the distiller besides. */
  inputs?: TemplateInput[];
  defaultAgentType: 'agent' | 'workflow';
  defaultMemoryScope: { readableLayers?: string[]; writableLayers?: string[] };
  /** The trigger a hire falls back to when distillation returns none
   *  (`distillResult.triggerConfig ?? template.defaultTriggerConfig`), so an
   *  invented topic here is an event subscription nothing ever delivers.
   *
   *  `eventTopics` declares EVERY topic the role handles, and it is not
   *  decoration either: it decides the per-binding filter, so a topic left out
   *  is an event the agent never sees. One template can therefore serve two
   *  kinds of source — cloud storage publishes `file.created`, the documents
   *  family publishes `document.created` — and each bound connector delivers
   *  only what it emits. `eventTopic` stays the primary of that set. */
  defaultTriggerConfig: {
    type: 'cron' | 'event' | 'manual';
    cronExpr?: string;
    eventTopic?: string;
    eventTopics?: string[];
    timezone?: string;
  };
  schemaVersion: number;

  // Legal document review extensions (schemaVersion: 2)
  practiceName?: string;        // e.g. 'Finance', 'Corporate', 'Employment'
  extractionSchema?: ExtractionColumn[]; // ordered column definitions for tabular review agents
  /** This role must check whether it has already acted on a thing before acting
   *  on it again, and the graph must carry the step that checks.
   *
   *  Declared rather than inferred, for the same reason `extractionSchema` is:
   *  an obligation stated only in prose is one the distiller may or may not
   *  compile into a step, and nothing downstream can tell. Two hires of one
   *  template, minutes apart, can disagree on whether the delivery step exists
   *  at all. Prose is an instruction; this is a fact a validator can hold the
   *  graph to.
   *
   *  Set it wherever the responsibilities say to confirm the work was not
   *  already done. That promise is not decoration: an event source re-delivers,
   *  a document is renamed and re-notified, and a second reply to a customer
   *  cannot be taken back. */
  requiresIdempotencyCheck?: boolean;

  /** This role reports a change against a previous run, so the graph must WRITE
   *  this run's record as well as read the last one.
   *
   *  The read half fails loudly enough to notice: with nothing on record the
   *  agent says so. The write half fails silently and permanently — a run that
   *  skips it breaks the NEXT comparison rather than its own, and every run
   *  after that. A series with a hole in it is indistinguishable from a series.
   *
   *  Declared rather than inferred for the same reason as
   *  `requiresIdempotencyCheck`: an obligation that lives only in prose is one
   *  the graph is free to omit. The obligation lapses when no store is bound,
   *  which is case (b3)'s own rule: with nowhere to keep a series, the honest
   *  answer is to report the current figures and say there is no prior period. */
  comparesWithLastRun?: boolean;

  /** This role's deliverable is a FILE, and the graph must contain the step
   *  that makes it where the workspace can hold one.
   *
   *  Case (b4) has three branches — a documents tool creates natively, cloud
   *  storage takes a generate-then-place pair, neither returns a link — and the
   *  branch is decided by what is bound, not by the prose. So the check is
   *  branch-aware rather than a single required tool: with a documents or
   *  cloud-storage connector bound, the graph must write the artifact to it;
   *  with neither, the obligation lapses, because the platform's own file
   *  registration cannot be identified from the graph reliably enough to demand
   *  it without risking a false rejection.
   *
   *  The failure it catches is a role that analyses, reports, and never
   *  produces the thing it was hired to produce. */
  producesDocument?: boolean;

  /** What ONE row of the deliverable is, when the deliverable holds MANY rows
   *  per document: "condition precedent", "reporting covenant".
   *
   *  Absent means one row per document, which is the common case: a review
   *  memo answers each topic once, so the columns fully describe the output and
   *  the row is the document itself. `tabular_extract` compiles that.
   *
   *  Present means the row count is a property of the document rather than of
   *  the template — a facility agreement has as many conditions precedent as it
   *  has, and no schema can say how many in advance. That inverts the
   *  extraction (one read returning an array, not one call per column) and so
   *  it compiles to `tabular_enumerate` instead. The columns are unchanged;
   *  only what a row MEANS differs, which is exactly what this says.
   *
   *  Meaningless without `extractionSchema`, and the validator says so. */
  extractionRowDefinition?: string;

  // ── The distillation input contract ────────────────────────────────────
  //
  // Every field below is OPTIONAL, and that is a product constraint rather
  // than caution: a template exists so a user never has to type out a
  // well-understood role, so a thin two-field template has to stay valid and
  // the enrichment cost has to fall on the catalog. Ratchets bind added and
  // edited templates only.
  //
  // The full contract, its three producers and the reasoning behind each
  // field live in @liftoffos/workforce-types/template-input-contract. Mirrored
  // here structurally rather than imported, because this package is the shape
  // of the wire and takes no dependencies.

  /** Authored prose split by heading. The composed `responsibilities` and
   *  `additionalContext` remain authoritative and stay derivable via
   *  `composeProseSections`, so the two can never disagree about what the
   *  template says. */
  sections?: Record<string, string | undefined>;

  /** Named sub-workflows with the keys that decide when to retrieve them.
   *
   *  `notNeededFor` is not decoration: without an exclusion a key competes
   *  with its siblings inside one agent's top-K, and two flows that both match
   *  every request mean retrieval is choosing by tie-break. */
  flows?: Array<{
    id: string;
    name: string;
    useWhen: string;
    notNeededFor: string;
    body: string;
    companionCron?: string;
  }>;

  /** Rules read while ONE call's arguments are written, keyed by CAPABILITY so
   *  they survive a different connector binding. */
  toolNotes?: Record<string, string>;

  /** What the agent can do with a capability, in three states. `absent` means
   *  the platform cannot do it at all, which two states could not express — so
   *  prose promised work nothing could carry out. */
  capabilities?: Record<string, 'live' | 'unwired' | 'absent'>;

  /** Domain vocabulary, rendered as a flow's first line, glossed where it is
   *  read rather than in a preamble already scrolled past. */
  domainAliases?: Record<string, string>;

  /** Eval cases. `expected` carries only the keys the case is about: a case
   *  that pins everything pins the ROUTE as well as the answer, and then any
   *  correct-but-different route fails it. */
  evals?: Array<{
    id: string;
    state?: Record<string, unknown>;
    /** Run the case as an event rather than a chat turn. */
    trigger?: { source: string; entityType: string; payload?: Record<string, unknown> };
    turns: string[];
    expected: {
      calls_tool?: string[];
      /** Satisfied by any ONE of these, for a behaviour with several honest routes. */
      calls_any_of?: string[];
      never_calls?: string[];
      /** Not called on the FINAL delivery of a multi-delivery trigger case.
       *
       *  For "the same event arrived twice; act only the first time".
       *  `never_calls` cannot say it — forbidding the action outright forbids
       *  the one the case is asking for — and counting calls cannot either,
       *  since one GitHub review is four calls to the same tool. */
      last_delivery_never_calls?: string[];
      first_tool?: string;
      reply_includes?: string[];
      reply_omits?: string[];
      /** Asserted against the arguments the agent passed to its tools. */
      writes_include?: string[];
      /** Satisfied by any ONE of these phrasings — for a message the role is
       *  told to convey, not a string it is told to write. */
      writes_include_any?: string[];
      writes_omit?: string[];
      no_skill_load?: boolean;
      rubric?: string;
    };
    counterpartOf?: string;
  }>;

  /** The agent may only write to a record this run has actually seen.
   *
   *  An obligation rather than prose, for the same reason as the three above
   *  it: prose promising the behaviour is not enforcement. The tenant runtime's
   *  write gate is, and a validator net ties the two together so a template
   *  cannot promise it in prose while leaving the flag unset. */
  writesRequireProvenance?: boolean;
}
