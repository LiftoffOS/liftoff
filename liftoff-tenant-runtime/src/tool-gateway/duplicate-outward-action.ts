// The same outward act, twice in one run.
//
// WHY AT THE DISPATCH POINT AND NOT ABOVE IT
// ──────────────────────────────────────────
// Three attempts have been made at this problem one layer too high. A graph
// rule (`action-repetition.ts` in platform-backend) cannot see inside an
// `llm_reason` step, and cannot see an agent that has no graph. A prompt rule
// does not bind a model under pressure. The platform writing on the agent's
// behalf answers for it rather than stopping it.
//
// `execute()` is the lowest place where an outward action is a FACT rather than
// an intention, and it is the same wrapper that already records the action
// ledger and the governance WAL — chosen for the same reason those moved there:
// a branch added tomorrow cannot silently opt out.
//
// THE KEY
// ───────
//   tenant + agent + run + target_ref + target_version + action_type + method
//
// `target_ref` and `target_version` come from `deriveTarget`, which the ledger
// already writes. Version in the key is what lets a legitimate re-review at a
// new head sha through: same pull request, new commits, different key.
//
// A line-anchored comment carries its own target (`…#81:src/a.ts:42`), so a
// review that comments on ten lines is ten different targets and none of them
// collides. Two pull-request-level summaries carry the same target and the
// second is refused, however differently each is worded — which is the case
// worth catching and the one a payload hash could never catch.
//
// SCOPE IS THE RUN, NOT ALL OF TIME
// ─────────────────────────────────
// "Have I ever done this" is the ledger's question and `have_i_acted_on`
// answers it. This asks only "have I done it twice in the run I am in".
// Conflating them would block tomorrow's legitimate review of the same pull
// request.
//
// WHY THE LEDGER AND NOT AN IN-PROCESS MAP
// ────────────────────────────────────────
// HITL pauses, clarification answers and wakes all resume a run in a different
// process, and Cloud Run does not pin an invocation to an instance. An
// in-memory set is empty exactly on the long, interrupted runs most likely to
// repeat themselves. The row already exists — this reads what `execute()` just
// wrote rather than keeping a second, weaker copy of the same fact.
//
// THE INDEX, CHECKED RATHER THAN ASSUMED
// ──────────────────────────────────────
// `idx_actions_target_lookup (tenant_id, agent_id, target_ref, created_at DESC)`
// from migration 373 already serves this. EXPLAIN shows:
//
//   Limit
//     ->  Index Scan using idx_actions_target_lookup on actions
//           Index Cond: (tenant_id = … AND agent_id = … AND target_ref = …)
//           Filter: (target_version IS NULL AND status = ANY(…)
//                    AND trace_id = … AND action_type = …)
//
// The three equality columns in the Index Cond are the selective ones — a
// specific target_ref is a handful of rows — so the remaining predicates filter
// a tiny heap set. No sequential scan, and no covering index worth adding.
//
// ONE NAME OVER FIVE OPERATIONS
// ─────────────────────────────
// `action_type` is not always the act. GitHub's review tool is a MULTIPLEXER:
// `pull_request_review_write { method: 'create' }` opens the draft container and
// `{ method: 'submit_pending' }` publishes it, and the three-op review flow
// calls both, on the same pull request, inside one run. Keyed on the action
// name alone those two are indistinguishable, so the guard would refuse the
// publish and every review would end as an unpublished draft — the guard
// against posting twice, turned into a guarantee of posting never.
//
// So the multiplexed method is part of the key. It is read from the payload
// rather than folded into `action_type`, because `action_type` is what the
// ledger and `resolve-trigger-bound-tool` both match on, and it is read ONLY
// from `method`: a wider scan would pick up `action`, which on a GitHub webhook
// payload means the event that fired, and keying on that would split two
// genuine repeats apart.
//
// WHAT THIS CANNOT SEE
// ────────────────────
// Sandbox work. `backstopLedger` deliberately exempts sandbox primitives, so a
// `gh pr review` issued from a shell is invisible here exactly as it is to
// `have_i_acted_on`. So this closes the class for
// connector-dispatched work and leaves the sandbox open. The remedy for GitHub
// specifically is routing review posts through the connector rather than the
// shell, which is now possible because the App identity works. See
// docs/design/have-i-acted-on-this.md.

// `getPool()` and not the bare `pool` export, which is a Proxy onto exactly
// this call — identical in production, and NOT identical under test. A suite
// that mocks the database module replaces each export independently, so
// `execute-batch.test.ts` mocking `getPool` and omitting `pool` left this
// lookup calling a method on `undefined`: it threw, the guard failed open, and
// the suite went green against a check that never ran. One accessor is one
// thing a mock can fail to cover.
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { equivalentActKeys, isContentActKey, type DerivedTarget } from '../action-ledger/target-ref';
import { uuidOrNull } from '../agent-execution/run-identity';
import type { ExecuteInput, ExecuteResult } from './types';

export interface DuplicateHit {
  actionId: string;
  createdAt: string;
  /** What the FIRST call actually returned. Present for a ledger hit, absent
   *  for an in-batch twin that has not dispatched — which is exactly the
   *  distinction that decides whether the second call can be ANSWERED or only
   *  refused. */
  externalResponse?: unknown;
  /** True when the twin is a sibling in the SAME batch that has not dispatched
   *  yet. It changes what is true — "already done" is not — and so changes what
   *  the refusal says. */
  inFlight?: boolean;
}

/** `actions.trace_id` is stored truncated; the lookup must truncate identically
 *  or a long trace id matches nothing and the guard is silently inert. */
const TRACE_ID_MAX = 128;

/**
 * The operation a multiplexed action name is hiding, or null when there is none.
 *
 * See ONE NAME OVER FIVE OPERATIONS above. Deliberately one key: `method` is
 * what a multiplexing tool calls its selector, and every other candidate
 * (`action`, `op`, `type`) carries a different meaning somewhere that matters —
 * `action` in particular is the webhook verb on a GitHub event payload, which
 * would split two genuine repeats apart rather than telling two acts apart.
 *
 * Normalised to lower case so `Create` and `create` are one operation; a
 * non-string selector is treated as absent rather than stringified, because a
 * key built from `[object Object]` is a key that matches nothing.
 */
export function multiplexedOperation(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const m = (payload as { method?: unknown }).method;
  if (typeof m !== 'string') return null;
  const trimmed = m.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * The stand-in "first" for a sibling still in flight in the same batch.
 *
 * `DuplicateHit` names the earlier ACTION ROW, and an in-batch twin has none —
 * it has not dispatched, so it has no id and no ledger row to point at. Saying
 * so is the honest answer; inventing an id would point a reader at a row that
 * does not exist.
 */
export function inFlightInBatch(): DuplicateHit {
  return {
    actionId: 'a sibling call in the same batch',
    createdAt: new Date().toISOString(),
    inFlight: true,
  };
}

/**
 * Everything that makes two calls the SAME act, as one comparable string.
 *
 * Used for the within-batch check, where neither call has reached the ledger
 * yet and so neither can be found by `findCompletedDuplicate`. The parts are
 * exactly the ones the SQL key uses, in the same order, so the two checks
 * cannot drift on what counts as the same act.
 */
export function duplicateKey(
  actionType: string,
  target: DerivedTarget,
  operation: string | null,
  /** The act's identity when it has no target. A create names nothing that
   *  exists yet, so `target.ref` is empty and every create of one action type
   *  in a batch collapsed onto the same key — which would suppress legitimately
   *  different creates rather than duplicates of one. The content key tells
   *  them apart; see `actKeyFor`. */
  actKey?: string | null,
): string {
  return [
    actionType,
    target.ref || (actKey ?? ''),
    target.version ?? '',
    operation ?? '',
  ].join('\u0000');
}

/**
 * Has this agent already completed this exact outward action, on this target,
 * at this version, inside this run?
 *
 * FAILS OPEN. A lookup that errors returns null and the action proceeds.
 * Blocking real work because a diagnostic read failed would be worse than the
 * duplicate it prevents, and would turn this guard into a new way for a working
 * agent to break.
 */
/** How far back the cross-run check looks. The same window `hasActedOn`
 *  defaults to, so the guard and the tool an agent can ask never disagree about
 *  what "before" covers. */
const CROSS_RUN_WINDOW_DAYS = 90;

/**
 * The same thing, at the same revision, already done in an EARLIER run.
 *
 * WHY THIS IS SEPARATE FROM THE RUN-SCOPED CHECK ABOVE, AND NARROWER.
 *
 * "Have I ever done this" is `have_i_acted_on`'s question and the agent has to
 * choose to ask it, and agents do not. An agent whose graph carries the step
 * may run the SDK loop, where the graph is not the executor, so the step never
 * fires. An obligation that depends on
 * the model deciding to check, or on which engine happens to run the agent, is
 * not an obligation.
 *
 * A VERSION IS REQUIRED, and that is the whole reason this can be safe.
 *
 * Scoping the old guard to the run was justified as "conflating them would
 * block tomorrow's legitimate review of the same pull request". True of the
 * ENTITY and false of the entity AT A REVISION: new commits are a new head sha,
 * a different target_version, and a different key. What is left is the case
 * that cannot be legitimate — the identical revision, acted on twice.
 *
 * So an unversioned target is deliberately untouched. A weekly digest posted to
 * the same channel every Monday names no revision, and refusing the second one
 * would break a working agent to prevent nothing. Repeats of that shape are
 * addressed where they can be seen rather than where they are indistinguishable
 * from correct work: the prior-work block lists what the agent has already
 * produced, by name, before it decides to produce it again.
 *
 * Reads the same index as its sibling — `idx_actions_target_lookup` leads with
 * (tenant_id, agent_id, target_ref), and trace_id was only ever a filter.
 */
export async function findPriorVersionedAct(
  input: Pick<ExecuteInput, 'tenantId' | 'agentId' | 'traceId' | 'actionType' | 'payload'>,
  target: DerivedTarget,
): Promise<DuplicateHit | null> {
  if (!target.ref || !target.version) return null;
  if (!input.tenantId || !input.agentId) return null;

  try {
    const result = await getPool().query<{
      id: string; created_at: string; external_response: unknown;
    }>(
      `SELECT id, created_at, external_response
         FROM actions
        WHERE tenant_id = $1
          AND agent_id = $2
          AND target_ref = $3
          AND target_version = $4
          AND action_type = $5
          AND NULLIF(LOWER(BTRIM(payload->>'method')), '') IS NOT DISTINCT FROM $6
          AND status IN ('completed', 'succeeded')
          AND trace_id IS DISTINCT FROM $7
          AND created_at > now() - ($8 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [
        input.tenantId,
        input.agentId,
        target.ref,
        target.version,
        input.actionType,
        multiplexedOperation(input.payload),
        input.traceId ? input.traceId.substring(0, TRACE_ID_MAX) : null,
        String(CROSS_RUN_WINDOW_DAYS),
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actionId: String(row.id),
      createdAt: String(row.created_at),
      externalResponse: row.external_response ?? undefined,
    };
  } catch (err) {
    // Fails OPEN, like its sibling. A guard that cannot read the ledger knows
    // nothing, and refusing real work on a failed diagnostic read is worse than
    // the duplicate it would have caught.
    logger.warn({
      err: (err as Error).message,
      tenant_id: input.tenantId,
      target_ref: target.ref,
    }, 'duplicate-outward-action: cross-run lookup failed, allowing the call');
    return null;
  }
}

export async function findCompletedDuplicate(
  input: Pick<ExecuteInput, 'tenantId' | 'agentId' | 'traceId' | 'actionType' | 'payload' | 'invocationId'>,
  target: DerivedTarget,
  /** The act's identity (`actKeyFor`). When given, the lookup matches on it and
   *  on every key that means the same act; a row written before act keys
   *  existed is still matched by target and action type. */
  actKey?: string | null,
): Promise<DuplicateHit | null> {
  // No target AND no key means nothing to compare. `deriveTarget` returns an
  // empty ref for payloads that name no entity, and treating those as equal
  // would collapse every unkeyed action in a run onto one another.
  //
  // A CONTENT key is the exception, and the reason this is not simply
  // `!target.ref`: an act that creates something has no target — the thing does
  // not exist yet — so bailing here exempted every create on every connector
  // from the guard. A content key says what would be written, which is identity
  // enough for "this exact act already happened in this run", and the clause
  // below matches it on `act_key` rather than on the target it does not have.
  if (!target.ref && !actKey) return null;
  if (!input.traceId || !input.tenantId || !input.agentId) return null;

  // THE RUN is the invocation when the row names one, and the trace otherwise.
  // A resume rebuilds the context with a different trace id from the process
  // that paused, so an act completed before the pause and the same act proposed
  // after it are one run by invocation and two by trace. Rows written before
  // `invocation_id` existed, and writers with no invocation in scope, still
  // match by trace.
  //
  // IS NOT DISTINCT FROM, not =. NULL is a legitimate version ("the payload
  // named no revision") and equality never matches it, so an `=` here would
  // make the guard inert for every connector that names no revision, which is
  // most of them. The same holds for the multiplexed method: most actions carry
  // none, and an `=` would exempt every one of them.
  //
  // The method is compared against the STORED payload rather than a column,
  // because `actions` has no column for it and the payload is already written
  // in full. It stays out of the index and filters the handful of rows the
  // equality columns select — see THE INDEX, above.
  const equivalents = actKey ? equivalentActKeys(actKey) : null;
  try {
    const result = await getPool().query<{
      id: string; created_at: string; external_response: unknown;
    }>(
      `SELECT id, created_at, external_response
         FROM actions
        WHERE tenant_id = $1
          AND agent_id = $2
          AND (
            ($3::uuid IS NOT NULL AND invocation_id = $3::uuid)
            OR (invocation_id IS NULL AND trace_id = $4)
          )
          AND (
            ($5::text[] IS NOT NULL AND act_key = ANY($5::text[]))
            OR ($6::text IS NOT NULL AND act_key LIKE $6::text ESCAPE '\\')
            OR ($7::text IS NOT NULL AND act_key IS NULL AND target_ref = $7 AND action_type = $8)
          )
          AND target_version IS NOT DISTINCT FROM $9
          AND NULLIF(LOWER(BTRIM(payload->>'method')), '') IS NOT DISTINCT FROM $10
          AND status IN ('completed', 'succeeded')
        LIMIT 1`,
      [
        input.tenantId,
        input.agentId,
        uuidOrNull(input.invocationId),
        input.traceId.substring(0, TRACE_ID_MAX),
        equivalents ? equivalents.exact : null,
        equivalents?.capabilityLike ?? null,
        // Null for a content-keyed act, which disables the legacy
        // target-comparison clause: an act keyed on what it WRITES has no
        // target, and an empty target_ref there would match every other
        // unkeyed row of the same action type in the run.
        isContentActKey(actKey) || !target.ref ? null : target.ref,
        input.actionType,
        target.version,
        multiplexedOperation(input.payload),
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actionId: String(row.id),
      createdAt: String(row.created_at),
      externalResponse: row.external_response ?? undefined,
    };
  } catch (err) {
    logger.warn({
      err: (err as Error).message,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      action_type: input.actionType,
      target_ref: target.ref,
    }, 'duplicate-action guard: lookup failed, allowing the action');
    return null;
  }
}

/**
 * ALREADY DONE, ANSWERED WITH WHAT THE FIRST CALL RETURNED.
 *
 * A refusal was the wrong SHAPE for a graph. `executeToolStep` reads
 * `success: false` and fails the step, which takes its `onFailure` branch — so
 * "you already did this" did not merely skip an action, it routed the workflow
 * somewhere else, and a step whose postcondition was ALREADY SATISFIED was
 * treated as one that had not run. That is backwards, and on a graph it is
 * worse than the duplicate it prevents.
 *
 * NOT the stub success the platform forbids. Nothing here is fabricated: this
 * returns the external response the FIRST identical act actually recorded — same
 * target, same version, same method, same run. It is the blessed behaviour of
 * the idempotency short-circuit a few hundred lines up, which replays
 * `existingAction.externalResponse` for a repeated idempotency key, generalised
 * from "the same key" to "the same act on the same thing".
 *
 * The `notice` still says it happened, so the model learns it repeated itself
 * and the graph does not derail. A successful call carrying a notice is exactly
 * what that field exists for — both properties, instead of trading one away.
 */
export function duplicateReplay(
  input: Pick<ExecuteInput, 'traceId' | 'actionType' | 'payload'>,
  target: DerivedTarget,
  hit: DuplicateHit,
): ExecuteResult {
  const at = target.version ? ` at ${target.version}` : '';
  const op = multiplexedOperation(input.payload);
  const via = op ? ` (method \`${op}\`)` : '';
  return {
    success: true,
    data: hit.externalResponse ?? null,
    traceId: input.traceId,
    notice:
      `Already done in this run: \`${input.actionType}\`${via} on ${target.ref}${at}, `
      + `at ${hit.createdAt}. This is the result that call returned; nothing was sent a `
      + `second time. If you meant to act on something else, change the target — a `
      + `different line, a different pull request, or a new revision all count as `
      + `different. Otherwise move on; this one is finished.`,
  };
}

/**
 * The refusal, for the duplicate that CANNOT be answered.
 *
 * Kept for the in-batch twin: a sibling in the same batch has not dispatched, so
 * there is no recorded response to hand back, and inventing one would be exactly
 * the stub success `duplicateReplay` is careful not to be. A refusal is the
 * honest answer when the first call's result does not exist yet.
 *
 * NOT a silent drop, and NOT a fabricated success. Suppressing the call and
 * reporting success is a stub success — an explicit platform invariant forbids
 * it, and it is the same defect class the connector-service `{success:false}`
 * work removed. The model is told what happened and continues, so a duplicate
 * becomes visible instead of either happening or vanishing.
 *
 * The message goes in `notice` as well as `error` because `notice` is what the
 * tool result leads with, ahead of the JSON blob.
 */
export function duplicateRefusal(
  input: Pick<ExecuteInput, 'traceId' | 'actionType' | 'payload'>,
  target: DerivedTarget,
  hit: DuplicateHit,
): ExecuteResult {
  const at = target.version ? ` at ${target.version}` : '';
  // The method is named when there is one, so a refusal on a multiplexed tool
  // says which of its operations was repeated rather than naming a tool that
  // legitimately runs several times per review.
  const op = multiplexedOperation(input.payload);
  const via = op ? ` (method \`${op}\`)` : '';
  // An in-flight twin has not happened yet, so the refusal does not claim it
  // has. A message that misreports what was done is the same defect one layer
  // over from the one being refused.
  const lead = hit.inFlight
    ? `Already being done in this run, by a sibling call issued alongside this one: `
    : `Already done in this run: `;
  const when = hit.inFlight ? '' : `, at ${hit.createdAt}`;
  const message =
    `${lead}\`${input.actionType}\`${via} on ${target.ref}${at}${when}. `
    + `Repeating it would post a second copy. `
    + `If you meant to act on something else, change the target — a different line, `
    + `a different pull request, or a new revision all count as different. `
    + `Otherwise move on; this one is finished.`;

  return {
    success: false,
    data: null,
    traceId: input.traceId,
    error: message,
    notice: message,
    retryable: false,
  };
}
