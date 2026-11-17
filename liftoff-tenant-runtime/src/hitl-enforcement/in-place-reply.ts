// The in-place reply carve-out for the external-content write gate.
//
// The gate exists because untrusted content can steer an agent: a pull-request
// title is written by whoever opened it, and on a public repository that is
// anyone. So on an untrusted-inbound run, any non-read call gates.
//
// That is right for almost everything and wrong for one case. A Code Reviewer
// woken by PR #101 whose job is to comment on PR #101 adds no blast radius by
// doing exactly that: the entity it writes to already carries the untrusted
// content. Gating it means a person approves every review comment forever, and
// a queue of approvals that did not need approving is how people learn to
// approve without reading — which costs more safety than it buys.
//
// WHY AN ALLOWLIST, NOT "anything non-destructive"
// ────────────────────────────────────────────────
// The first draft of this file allowed any write that was not tagged
// `destructive` or `outbound`. That was unsafe, and the vendor classifier says
// exactly why: `merge_pull_request` tokenizes to [merge, pull, request], and
// `merge` sits in WRITE_VERBS, not DESTRUCTIVE_VERBS. It classifies as
// ['dataChanges'] — not destructive. So "non-destructive write to the entity
// that woke me" would have let an agent MERGE the pull request that woke it,
// with no approval. The single worst case walked straight through the
// carve-out.
//
// Vendor tools also use a different category vocabulary than connector tools
// (customerCommunication / externalPublishing rather than `outbound`), and
// `add_issue_comment` is tagged customerCommunication — which a pull-request
// comment plainly is not. So category tags can neither be trusted to catch the
// dangerous case nor to permit the safe one.
//
// Hence: a reply is a SPECIFIC, NAMED operation. Anything not on this list
// gates, whatever it is tagged. Adding to the list is a deliberate act that
// should be argued for in review.

/** The entity the run was woken by, from the normalized event record. */
export interface TriggerTarget {
  /** Connector type that fired: 'github', 'gitlab'. */
  source?: string;
  /** GitHub "owner/repo"; GitLab project web URL. */
  repository?: unknown;
  /** GitLab project id. */
  repositoryId?: unknown;
  /** Per-repository number: GitHub PR number, GitLab merge-request IID. */
  number?: unknown;
  /** Mail: the thread the run was woken by. Spelled both ways depending on
   *  delivery path, so both are read. */
  threadId?: unknown;
  thread_id?: unknown;
  /** Mail: the message id, used when the payload carries no separate thread. */
  id?: unknown;
}

export interface CallUnderTest {
  name: string;
  input?: Record<string, unknown>;
  categories?: string[];
  effect?: 'read' | 'write' | 'spawn';
  /** 'ack' marks the operation that records a work item as handled, declared
   *  per connector in connector-functions-registry.ts. */
  workRole?: 'inbox' | 'ack';
}

/**
 * Operations that are a REPLY on the triggering entity, per host.
 *
 * Deliberately narrow and deliberately explicit. Every entry adds a comment to
 * a pull request or merge request and does nothing else — it cannot merge,
 * close, label, assign, edit code, or reach another system.
 */
const REPLY_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  github: [
    'add_issue_comment',
    'add_comment_to_pending_review',
    'add_reply_to_pull_request_comment',
    'create_pull_request_comment',
    // The review CONTAINER's lifecycle. `add_comment_to_pending_review` above
    // attaches a finding to a pending review, and without the bracket that
    // opens and publishes it, the allowlist covered the middle of the flow and
    // neither end — so a reviewer gated on its first step and never reached the
    // one operation it was already permitted.
    //
    // Admitted by name here and then interrogated by ARGUMENT_GUARDS below,
    // because this single name is five different operations.
    'pull_request_review_write',
  ],
  gitlab: [
    'create_merge_request_note',
  ],
};

/**
 * Operations whose safety depends on their ARGUMENTS, not only their name.
 *
 * The allowlist above is keyed on the bare action, which assumes one name means
 * one operation. `pull_request_review_write` breaks that assumption: it is
 * method-dispatched over
 * `create | submit_pending | delete_pending | resolve_thread | unresolve_thread`
 * and carries an `event` of `APPROVE | REQUEST_CHANGES | COMMENT`.
 *
 * So permitting it by name would also permit an agent to APPROVE the pull
 * request that woke it. An approval is not a comment: it satisfies branch
 * protection and can unblock a merge, which is the blast radius this file
 * already refuses for `merge_pull_request` — the case that killed the first
 * draft of the whole carve-out. Name-level permission is structurally unable to
 * express the difference, so the difference is expressed here.
 *
 * Fail closed, like everything else in this module: a method this does not
 * recognise, or an `event` it cannot read, answers false and gates.
 */
const ARGUMENT_GUARDS: Readonly<
  Record<string, (input: Record<string, unknown>) => boolean>
> = {
  pull_request_review_write: (input) => {
    const method = typeof input.method === 'string' ? input.method.toLowerCase() : '';

    // Opening and discarding a DRAFT reach nobody. Nothing is visible on the
    // pull request until it is submitted, so there is no external effect to
    // bound and no third party to reach.
    if (method === 'create' || method === 'delete_pending') return true;

    // `resolve_thread` / `unresolve_thread` mark a HUMAN's review thread
    // resolved. That is not the agent replying in place, it is the agent
    // dismissing someone else's feedback, and it keeps its gate.
    if (method !== 'submit_pending') return false;

    const event = typeof input.event === 'string' ? input.event.toUpperCase() : '';
    // Publishing findings is what the reviewer exists to do. APPROVE is not a
    // finding — it is a merge-enabling verdict — so it stays gated.
    //
    // An ABSENT event is not read as a benign default. GitHub may well default
    // it to COMMENT, but a carve-out that infers intent from a missing argument
    // is guessing, and this module's whole design is that a near-miss resolves
    // to false.
    return event === 'COMMENT' || event === 'REQUEST_CHANGES';
  },
};

/**
 * Operations that produce a DRAFT — something a human must still send.
 *
 * Allowed on any untrusted-inbound run, whatever woke it, because a draft has
 * no external reach: it lands in the user's Drafts folder and goes nowhere
 * until a person sends it. The human is the send button, which is a stronger
 * control than an approval queue and a much smaller interruption.
 *
 * This matters most for support work. Inbound customer mail is the least
 * trustworthy content the platform ingests, so those connectors belong in
 * EXTERNAL_AUTHORED_CONNECTORS — but under `communication='draft'` the outbound
 * send is not registered at all and only the draft form is, so gating the draft
 * would mean asking permission to WRITE A DRAFT. That is the same
 * approve-without-reading fatigue the reply carve-out exists to remove, and it
 * would fire on every customer email.
 *
 * Sending still gates. Drafting does not.
 */
const DRAFT_OPERATIONS: readonly string[] = [
  'create_draft',
  'create_reply_draft',
];

/**
 * Mail housekeeping ON the thread that woke the run.
 *
 * Not a reply — it sends nothing. `mark_as_read` clears the UNREAD label on the
 * one thread this run was triggered by, which is how the agent records that it
 * has dealt with the mail. It reaches no third party, changes no other record,
 * and is the last step of nearly every inbound-mail workflow.
 *
 * Gating it produces an approval card reading "Mark email thread <id> as read".
 * Nobody can meaningfully assess that, and a queue
 * of them buries the escalations that do need a person — the same cost the read
 * carve-out exists to avoid.
 *
 * Held to the SAME identity proof as the code hosts: the thread named in the
 * call must be the thread that woke the run. A mark_as_read on any other thread
 * is not in place and still gates.
 *
 * `reply_to_thread` is deliberately absent. It is tagged `outbound`, so the
 * Communication policy governs it and the invariant exempts it long before this
 * check — and the guard below refuses anything tagged outbound anyway.
 */
const MAIL_IN_PLACE_OPERATIONS: readonly string[] = [
  'mark_as_read',
];

/** Sources whose triggering entity is a mail thread. */
const MAIL_SOURCES: readonly string[] = ['google_mail', 'microsoft_outlook_mail'];

/** Bare action name from `<alias>__<action>` (or the name itself). */
function bareAction(name: string): string {
  const i = name.lastIndexOf('__');
  return i < 0 ? name : name.slice(i + 2);
}

/** Argument names that identify WHICH record a call acts on, per host shape.
 *  Explicit rather than pattern-matched: a near-miss here silently widens the
 *  carve-out, which is the one failure this module must not have. */
const NUMBER_ARGS = ['issue_number', 'pullNumber', 'pull_number', 'merge_request_iid', 'iid', 'number'];

function firstDefined(input: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (input[k] !== undefined && input[k] !== null) return input[k];
  return undefined;
}

function sameNumber(a: unknown, b: unknown): boolean {
  const x = Number(a); const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}


/**
 * Identifier-shaped argument names. An acknowledgement names the record it acks
 * through one of these, whatever the connector calls it.
 */
function identifierValues(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const key = k.toLowerCase();
    const looksLikeId =
      key === 'id' || key === 'key' || key === 'number' || key === 'iid'
      || key.endsWith('_id') || key.endsWith('id') || key.endsWith('_key')
      || key.endsWith('_iid') || key.endsWith('_number');
    if (looksLikeId) out.push(String(v));
  }
  return out;
}

/**
 * Is this the connector's declared ACK, aimed at the record that woke the run?
 *
 * `workRole: 'ack'` is authored per connector in the connector service's
 * function registry — Gmail's update_message, Jira's transition_issue,
 * Zendesk's update_ticket, Linear's update_issue, and so on. It names the
 * operation that records a work item as handled, which is the last step of
 * every reactive workflow and the one write that adds no blast radius: the
 * record being written is the record already carrying the untrusted content.
 *
 * This replaces asking, per host, "is this operation on my list". The registry
 * already states it, so a connector added tomorrow is covered the day its
 * functions are declared rather than the day someone remembers this file.
 *
 * Still fail-closed on all three legs, and all three must hold:
 *   - the tool must be DECLARED an ack (not inferred from its name),
 *   - it must not be tagged destructive, outbound or spawn,
 *   - and it must name the SAME record the run was triggered by.
 *
 * The last is an exact value match on identifier-shaped arguments. Record ids
 * are opaque, so matching the triggering record's own id is strong evidence and
 * a near-miss resolves to false rather than widening the carve-out.
 */
function isAckOnTriggerRecord(call: CallUnderTest, target: TriggerTarget): boolean {
  if (call.workRole !== 'ack') return false;

  const categories = (call.categories ?? []).map((c) => c.toLowerCase());
  if (categories.includes('destructive') || categories.includes('outbound')) return false;
  if (call.effect === 'spawn') return false;

  const called = identifierValues(call.input ?? {});
  if (called.length === 0) return false;

  const triggerIds = identifierValues(target as unknown as Record<string, unknown>);
  if (triggerIds.length === 0) return false;

  return called.some((c) => triggerIds.includes(c));
}

/** Is this call a reply on the very entity that woke the run?
 *
 *  Fail closed everywhere: an unknown operation, an unknown host, a missing
 *  record, or a target that cannot be compared all answer false. A carve-out
 *  that guesses is a hole. */
export function isInPlaceReply(call: CallUnderTest, target: TriggerTarget | undefined): boolean {
  if (!target) return false;

  const categoriesEarly = (call.categories ?? []).map((c) => c.toLowerCase());
  // A draft reaches nobody until a human sends it, so it is safe on any
  // untrusted run regardless of which connector fired — no target comparison
  // needed, because there is no external effect to bound. Still refused if the
  // catalog somehow tags it destructive or outbound: the list narrows, never
  // overrides.
  if (DRAFT_OPERATIONS.includes(bareAction(call.name))
      && !categoriesEarly.includes('destructive')
      && !categoriesEarly.includes('outbound')
      && call.effect !== 'spawn') {
    return true;
  }

  // The connector's own declared acknowledgement of the triggering record.
  // Registry-driven, so every connector that declares an ack is covered rather
  // than the handful this file was taught by hand.
  if (isAckOnTriggerRecord(call, target)) return true;

  const source = String(target.source ?? '').toLowerCase();

  // Mail housekeeping on the triggering thread, held to the same identity proof
  // as the code hosts below: the thread named must be the thread that woke us.
  if (MAIL_SOURCES.includes(source) && MAIL_IN_PLACE_OPERATIONS.includes(bareAction(call.name))) {
    if (categoriesEarly.includes('destructive') || categoriesEarly.includes('outbound')) return false;
    if (call.effect === 'spawn') return false;
    const calledThread = firstDefined(call.input ?? {}, ['thread_id', 'threadId']);
    if (typeof calledThread !== 'string' || calledThread.length === 0) return false;
    const triggerThread = firstDefined(
      target as unknown as Record<string, unknown>,
      ['threadId', 'thread_id', 'id'],
    );
    if (typeof triggerThread !== 'string' || triggerThread.length === 0) return false;
    return calledThread === triggerThread;
  }

  const allowed = REPLY_OPERATIONS[source];
  // A host this rule has not been taught cannot be confirmed in place.
  if (!allowed) return false;
  if (!allowed.includes(bareAction(call.name))) return false;

  // Admitted by name; now interrogated by argument. A name on the list whose
  // arguments describe something else — a review SUBMITTED as an approval
  // rather than as comments — is not the operation the list permitted.
  const argumentGuard = ARGUMENT_GUARDS[bareAction(call.name)];
  if (argumentGuard && !argumentGuard(call.input ?? {})) return false;

  // Belt and braces on top of the allowlist. If a tool on the list is ever
  // tagged destructive or spawning, the tag wins and it gates — the list is a
  // narrowing, never an override.
  const categories = (call.categories ?? []).map((c) => c.toLowerCase());
  if (categories.includes('destructive') || categories.includes('outbound')) return false;
  if (call.effect === 'spawn') return false;

  const input = call.input ?? {};
  const calledNumber = firstDefined(input, NUMBER_ARGS);
  if (calledNumber === undefined) return false;
  if (!sameNumber(calledNumber, target.number)) return false;

  // The number alone is not an identity — a GitLab IID of 1 exists in every
  // project, and PR #101 exists in many repositories.
  if (source === 'github') {
    const owner = input.owner;
    const repo = input.repo;
    if (typeof owner !== 'string' || typeof repo !== 'string') return false;
    return String(target.repository ?? '').toLowerCase() === `${owner}/${repo}`.toLowerCase();
  }
  // gitlab: `repository` is the project WEB URL, so repositoryId is the only
  // comparable identifier.
  const project = firstDefined(input, ['project_id', 'projectId', 'id']);
  if (project === undefined) return false;
  if (target.repositoryId === undefined || target.repositoryId === null) return false;
  return String(project) === String(target.repositoryId);
}

/**
 * Does this call name the entity that woke the run?
 *
 * The identity half of `isInPlaceReply`, on its own, for callers that need the
 * proof without the operation allowlist. Declared-scope gating is one: a step
 * in the approved graph dispatching its declared tool is authorised against the
 * TRIGGERING entity and nothing else, and "which entity" is exactly this
 * question.
 *
 * Lives here, beside `isInPlaceReply`, and is built from the same four
 * primitives it uses — NUMBER_ARGS, firstDefined, sameNumber, identifierValues.
 * A second identity comparison in another file is the defect this codebase has
 * already paid for: `f5a724a` fixed one that compared `String(repository)`
 * against an OBJECT and a top-level `number` against a nested
 * `pull_request.number`, and it was wrong for weeks while looking correct.
 * Changing one of these two functions means changing the other.
 *
 * Accepts any of the three proofs the trigger records support, because a
 * declared step may act on a pull request, a mail thread, or a generic record:
 *
 *   code host — the per-repository number AND the repository itself, because a
 *               number alone is not an identity: PR #101 exists in many
 *               repositories and a GitLab IID of 1 exists in every project.
 *   mail      — the thread named must be the thread that woke the run.
 *   generic   — an identifier-shaped argument matching one the trigger record
 *               carries. Record ids are opaque, so an exact value match is
 *               strong evidence.
 *
 * Fail closed on every leg. No target, no comparable identifier, or a near-miss
 * all answer false: a scope check that guesses is not a scope check.
 */
export function targetsTriggerEntity(call: CallUnderTest, target: TriggerTarget | undefined): boolean {
  if (!target) return false;
  const input = call.input ?? {};
  const source = String(target.source ?? '').toLowerCase();

  // ── Code host ──────────────────────────────────────────────────────
  const calledNumber = firstDefined(input, NUMBER_ARGS);
  if (calledNumber !== undefined && sameNumber(calledNumber, target.number)) {
    if (source === 'github') {
      const owner = input.owner;
      const repo = input.repo;
      if (typeof owner === 'string' && typeof repo === 'string') {
        return String(target.repository ?? '').toLowerCase() === `${owner}/${repo}`.toLowerCase();
      }
      return false;
    }
    // GitLab and the other hosts address by project id: `repository` holds the
    // project WEB URL there, so repositoryId is the only comparable identifier.
    const project = firstDefined(input, ['project_id', 'projectId', 'id']);
    if (project !== undefined && target.repositoryId !== undefined && target.repositoryId !== null) {
      return String(project) === String(target.repositoryId);
    }
    return false;
  }

  // ── Mail thread ────────────────────────────────────────────────────
  if (MAIL_SOURCES.includes(source)) {
    const calledThread = firstDefined(input, ['thread_id', 'threadId']);
    const triggerThread = firstDefined(
      target as unknown as Record<string, unknown>,
      ['threadId', 'thread_id', 'id'],
    );
    if (typeof calledThread === 'string' && calledThread.length > 0
        && typeof triggerThread === 'string' && triggerThread.length > 0) {
      return calledThread === triggerThread;
    }
    return false;
  }

  // ── Generic record ─────────────────────────────────────────────────
  const called = identifierValues(input);
  if (called.length === 0) return false;
  const triggerIds = identifierValues(target as unknown as Record<string, unknown>);
  if (triggerIds.length === 0) return false;
  return called.some((c) => triggerIds.includes(c));
}
