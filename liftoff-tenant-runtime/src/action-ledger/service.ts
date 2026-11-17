// Action Ledger Service Implementation
// Per Section 7: For every external write-capable action, persist action state
// Per Section 11: Persist structured audit logs with trace IDs and reversibility metadata

import { Action, ActionIntent } from './types';
import { ActionRepository, type ClaimResult } from './repository';
import { connectorRuleDerivesVersion } from './target-ref';
import { logger } from '../infrastructure/logging';
import { STANDARD_TOOL_EFFECTS, classifyVendorToolEffect } from '../tool-gateway/tool-effect';
import { SANDBOX_CONNECTOR } from '../agent-execution/tool-dispatch-family';
import { isSandboxTool } from '../execution-environments/function-registry';

/** Did this call reach the far side?
 *
 *  The answer the governance gate already computes, reused so the ledger and
 *  the gate cannot disagree about what a write is: a stated effect for our own
 *  tools, and the name-based classifier for a vendor's. */
function isOutwardWrite(connector: string, actionType: string): boolean {
  if (connector === SANDBOX_CONNECTOR || isSandboxTool(actionType)) return false;
  const effect = STANDARD_TOOL_EFFECTS[actionType] ?? classifyVendorToolEffect(actionType);
  return effect === 'write';
}

/** Whether two recorded versions name the same revision.
 *
 *  Exact equality answered no for the one connector that records a version at
 *  all. A git sha is written to the ledger in full — the API returns forty
 *  characters — while the event that wakes an agent carries the abbreviated
 *  form a person reads, and `2358e17 === 2358e179af17b24b…` is false. So a
 *  review WAS recorded and the agent asking "have I done this?" was told no,
 *  every time, for the same commit it had just reviewed.
 *
 *  Abbreviation is a prefix by construction, so this compares as one, with two
 *  guards. Both sides must be hexadecimal, since a prefix rule applied to
 *  arbitrary version strings would make "v1" match "v12". And the shorter side
 *  must reach git's own abbreviation floor of seven characters, below which a
 *  prefix stops naming one commit.
 */
const SHORT_SHA_MIN = 7;
const HEX_ONLY = /^[0-9a-f]+$/i;

export function sameVersion(a: string | null, b: string | null | undefined): boolean {
  if (a === null || b === null || b === undefined) return false;
  if (a === b) return true;
  if (!HEX_ONLY.test(a) || !HEX_ONLY.test(b)) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < SHORT_SHA_MIN) return false;
  return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

/** How long a claimed capability write may sit `pending` before another caller
 *  may take the claim over. Long enough for a slow vendor call; short enough
 *  that a process that died mid-dispatch does not block the act for the day. */
export const CAPABILITY_IN_FLIGHT_WINDOW_MS = 10 * 60_000;

export class ActionLedgerService {
  private repository = new ActionRepository();

  // Per Section 7: For every external write-capable action:
  // 1. persist action intent
  // 2. persist idempotency key
  // 3. persist target reference and pre-action snapshot reference
  // Per Section 11: Also persist:
  // - trace_id for distributed tracing correlation
  // - instruction_version for audit trail
  // - undo_support_mode for reversibility metadata
  // - conflict_resolution_mode for conflict handling audit

  async recordIntent(input: ActionIntent): Promise<string> {
    logger.info({
      message: 'Recording action intent',
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      connector: input.connector,
      action_type: input.actionType,
      entity_type: input.entityType,
      trace_id: input.traceId,
      undo_support_mode: input.undoSupportMode,
    });

    return this.repository.createAction({
      tenantId: input.tenantId,
      agentId: input.agentId,
      workflowId: input.workflowId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      connector: input.connector,
      entityType: input.entityType,
      actionType: input.actionType,
      targetRef: input.targetRef,
      targetVersion: input.targetVersion ?? null,
      preActionSnapshot: input.snapshot,
      traceId: input.traceId,
      instructionVersion: input.instructionVersion,
      undoSupportMode: input.undoSupportMode,
      conflictResolutionMode: input.conflictResolutionMode,
      payload: input.payload,
      snapshotStatus: input.snapshotStatus,
      // DERIVED HERE, not passed in. `is_external_write` has existed since
      // migration 033 with a DEFAULT of false, and nothing else sets it, so
      // every row reads false. Two features read it and both were therefore
      // inert: `acts-this-run` (the block that stops a reply misreporting what
      // it did) and `prior-work`.
      //
      // Deriving it from the caller's own `actionType` rather than adding a
      // field to ActionIntent is the point: four call sites record intent, and
      // a required argument is four chances to pass the wrong thing. The
      // classifier is the same one the governance gate uses, so the ledger's
      // idea of a write cannot drift from the gate's.
      //
      // Sandbox is excluded to match `backstopLedger`, which never records
      // sandbox work at all. A shell command that looks mutating is still not
      // an outward act, and the two surfaces must agree about that.
      isExternalWrite: isOutwardWrite(input.connector, input.actionType),
      invocationId: input.invocationId,
      actKey: input.actKey ?? null,
      status: 'pending',
    });
  }

  /**
   * Intent for a WRITE-CLASS CAPABILITY, which the classifier above cannot see.
   *
   * `run_capability` is a read by name — its true class lives in the opaque
   * handle — so `recordIntent` would file every capability send as a read and
   * `acts-this-run` / `prior-work` would never show it. This is the one other
   * way onto `is_external_write = true`, and it takes the write-marked handle as
   * its argument rather than a boolean: the mark the control plane minted is
   * the only proof the runtime holds, and a caller with a read handle gets a
   * throw, not a row. Everything else is `recordIntent`.
   */
  async recordCapabilityWriteIntent(input: ActionIntent, capabilityHandle: string): Promise<string> {
    if (typeof capabilityHandle !== 'string' || !capabilityHandle.startsWith('cap_w.')) {
      throw new Error('recordCapabilityWriteIntent: a write-marked capability handle is required');
    }
    logger.info({
      message: 'Recording capability write intent',
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      action_type: input.actionType,
      trace_id: input.traceId,
      invocation_id: input.invocationId,
    });
    return this.repository.createAction(this.capabilityWriteRow(input));
  }

  /**
   * Claim a capability write before dispatching it. Same requirement as
   * `recordCapabilityWriteIntent` — the write-marked handle — and the same row;
   * the difference is that the idempotency key is CLAIMED rather than
   * recorded, so an identical call racing this one is told to stand down or
   * to replay instead of both dispatching. See `ActionRepository.claimAction`.
   */
  async claimCapabilityWrite(
    input: ActionIntent,
    capabilityHandle: string,
    inFlightWindowMs = CAPABILITY_IN_FLIGHT_WINDOW_MS,
  ): Promise<ClaimResult> {
    if (typeof capabilityHandle !== 'string' || !capabilityHandle.startsWith('cap_w.')) {
      throw new Error('claimCapabilityWrite: a write-marked capability handle is required');
    }
    return this.repository.claimAction(this.capabilityWriteRow(input), inFlightWindowMs);
  }

  private capabilityWriteRow(input: ActionIntent): Record<string, unknown> {
    return {
      tenantId: input.tenantId,
      agentId: input.agentId,
      workflowId: input.workflowId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      connector: input.connector,
      entityType: input.entityType,
      actionType: input.actionType,
      targetRef: input.targetRef,
      targetVersion: input.targetVersion ?? null,
      preActionSnapshot: input.snapshot,
      traceId: input.traceId,
      instructionVersion: input.instructionVersion,
      undoSupportMode: input.undoSupportMode,
      conflictResolutionMode: input.conflictResolutionMode,
      payload: input.payload,
      snapshotStatus: input.snapshotStatus ?? 'skipped_no_snapshot_path',
      isExternalWrite: true,
      invocationId: input.invocationId,
      actKey: input.actKey ?? null,
      status: 'pending',
    };
  }

  // Per Section 7: Step 5 - persist external response
  // Step 6 - persist outcome
  /**
   * @param source The call that produced this result. Optional only because
   *  older callers predate it; without it a CREATE stays unkeyed.
   */
  async recordOutcome(
    actionId: string,
    result: any,
    source?: { connector: string; actionType: string; entityType?: string },
  ): Promise<void> {
    // WHAT AN AGENT MADE, which the intent could not record.
    //
    // `deriveTarget` reads the PAYLOAD, and a create's payload carries a title
    // and a body and no id — the id exists only in the response. So every
    // artifact an agent PRODUCES was recorded unkeyed, and every surface that
    // reads the ledger by target skipped exactly the rows describing the
    // agent's own output.
    //
    // An agent could then report that a battle card it had written itself did
    // not exist.
    //
    // The SAME function against the response rather than a second derivation:
    // a Docs create returns `documentId`, which the connector rule and the
    // generic id scan already know how to read. A parallel implementation here
    // would be free to disagree with the one the duplicate guard and
    // `have_i_acted_on` both key on, and nothing would compare them.
    let targetRefIfEmpty: string | undefined;
    if (source) {
      try {
        const { deriveTarget } = await import('./target-ref');
        const fromResult = deriveTarget({
          connector: source.connector,
          actionType: source.actionType,
          entityType: source.entityType,
          payload: (result?.data ?? result) as Record<string, unknown>,
        });
        targetRefIfEmpty = fromResult.ref || undefined;
      } catch (err) {
        // Never let this fail an outcome write. The row still records that the
        // call completed; it records it unkeyed, which is today's behaviour.
        logger.warn({ err: (err as Error).message, actionId }, 'action-ledger: target-from-result failed');
      }
    }
    await this.repository.updateAction(actionId, {
      externalResponse: result.data,
      targetRefIfEmpty,
      status: result.success ? 'completed' : 'failed',
      completedAt: new Date(),
    });
  }

  async recordFailure(actionId: string, error: any): Promise<void> {
    await this.repository.updateAction(actionId, {
      error: error.message || String(error),
      status: 'failed',
      completedAt: new Date(),
    });
  }

  /**
   * Audit Log Hardening: Record post-action snapshot for CREATE operations.
   * This snapshot becomes the "before" baseline for any future agent update
   * on the same record, enabling conflict detection from day one.
   */
  async recordPostActionSnapshot(actionId: string, snapshot: unknown): Promise<void> {
    await this.repository.updateAction(actionId, {
      postActionSnapshot: snapshot,
    });
  }

  async getById(id: string): Promise<Action | null> {
    return this.repository.findById(id);
  }

  async getByWorkflowId(workflowId: string): Promise<Action[]> {
    return this.repository.findByWorkflowId(workflowId);
  }

  // Per Section 7: Reconcile by idempotency key
  async getByIdempotencyKey(key: string): Promise<Action | null> {
    return this.repository.findByIdempotencyKey(key);
  }

  /**
   * Has this agent already acted on this thing?
   *
   * FOUR ANSWERS AND A BLIND SPOT, NOT TWO. A boolean cannot say the one thing
   * that matters most
   * here. Asked "have I reviewed PR #29 at head sha a450b99" against a ledger
   * row that recorded the review with no sha, `true` claims knowledge the
   * ledger does not have and `false` sends the agent to redo work it already
   * did. Both are confident and wrong, which is the failure this whole area
   * exists to stop — so "I acted on this, but I do not know at which revision"
   * is its own verdict and the caller is told to treat it as uncertain.
   *
   * The version comparison is done here rather than in SQL for the same reason:
   * a WHERE clause on target_version collapses "different revision" and
   * "unknown revision" into the same empty result as "never acted".
   */
  async hasActedOn(input: {
    tenantId: string;
    agentId: string;
    targetRef: string;
    targetVersion?: string | null;
    scope?: 'agent' | 'tenant';
    windowDays?: number;
    limit?: number;
  }): Promise<PriorActionAnswer> {
    const windowDays = input.windowDays && input.windowDays > 0 ? Math.min(input.windowDays, 365) : 90;
    const scope = input.scope ?? 'agent';
    const rows = await this.repository.findPriorActionsOnTarget({
      tenantId: input.tenantId,
      agentId: input.agentId,
      targetRef: input.targetRef,
      scope,
      windowDays,
      limit: input.limit ?? 20,
    });

    const actions = rows.map((row) => ({
      actionType: row.actionType,
      connector: row.connector,
      version: row.targetVersion,
      at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));

    let verdict: PriorActionVerdict;
    if (rows.length === 0) {
      verdict = 'no_record';
    } else if (!input.targetVersion) {
      verdict = 'acted';
    } else if (rows.some((r) => sameVersion(r.targetVersion, input.targetVersion))) {
      verdict = 'acted';
    } else if (rows.every((r) => r.targetVersion === null)) {
      verdict = 'acted_version_unknown';
    } else {
      verdict = 'acted_at_other_version';
    }

    // WHY the verdict came out the way it did, when the reason is that this
    // ledger cannot grade revisions on this connector at all.
    //
    // `acted` and `acted_version_unknown` both read as "you already did this",
    // and on sixteen of seventeen connectors they are the ONLY two answers
    // reachable — `deriveTarget` records a version for GitHub and for nothing
    // else, and no Docs/Slack/Gmail write payload carries one of VERSION_KEYS
    // by accident. A caller asking "is my prior work still good?" therefore
    // gets a confident yes that is really a statement about dispatch, and the
    // verdict alone gives it no way to know that.
    //
    // A research sweep is the worked example: if its deliverable is emptied,
    // the ledger still holds the write, and the only verdicts available say the
    // digest exists. Reading the document settles it in one call.
    //
    // Read off the target ref rather than passed in, because the ref is what
    // the answer is about and it already carries the type.
    const connectorType = input.targetRef.includes(':')
      ? input.targetRef.slice(0, input.targetRef.indexOf(':'))
      : input.targetRef;
    const versionBasis: VersionBasis = rows.length === 0
      ? 'no_rows'
      : rows.some((r) => r.targetVersion !== null)
        ? 'recorded'
        : connectorRuleDerivesVersion(connectorType)
          ? 'absent_on_these_rows'
          : 'unavailable_for_connector';

    // The blind spot rides on every answer, affirmative ones included: there it
    // means the listed actions may be an undercount rather than the whole story.
    return {
      target: input.targetRef, verdict, actions, windowDays, scope,
      unobserved: ['sandbox_shell'],
      versionBasis,
    };
  }
}

export type PriorActionVerdict =
  /** Acted on it — at the revision asked about, or no revision was asked about. */
  | 'acted'
  /** Acted on it, but every record names a different revision. The thing has
   *  moved on since; treat the prior work as superseded. */
  | 'acted_at_other_version'
  /** Acted on it, but no record names a revision, so whether the prior work
   *  covers the revision asked about is unknown. Not a "no". */
  | 'acted_version_unknown'
  /** NO RECORD within the window — which is not the same as "did not happen",
   *  and the name has to say so.
   *
   *  It was `not_acted`, and the distinction lived in a doc comment the model
   *  never reads. The ledger does not record sandbox work: `backstopLedger`
   *  exempts sandbox primitives, so an agent that posted a review with
   *  `gh pr review` from a shell asks this tool and is told the same word it
   *  would hear if nothing had happened at all. That is how six reviews posted
   *  in twelve hours against zero GitHub rows in `actions`.
   *
   *  `no_record` is answerable from what the ledger holds. `not_acted` was a
   *  claim about the world that the ledger is in no position to make. */
  | 'no_record';

/** A surface this answer cannot see, named so the caller can weigh it.
 *
 *  Prose in a `coverage` string is advisory and gets skimmed; a structured
 *  field can be reasoned about, and it is the difference between an agent
 *  treating `no_record` as "go ahead" and treating it as "go ahead unless you
 *  might have done this in a shell". */
export type UnobservedSurface = 'sandbox_shell';

/** Why the answer above grades revisions the way it does.
 *
 *  `recorded`               at least one prior action names a revision, so
 *                           `acted_at_other_version` is reachable and a version
 *                           comparison means something.
 *  `absent_on_these_rows`   this connector's rule DOES derive a revision, and
 *                           these particular rows carry none. Unusual, and
 *                           worth the caller's suspicion.
 *  `unavailable_for_connector`
 *                           this connector's rule derives no revision at all,
 *                           so no row here ever will. `acted` and
 *                           `acted_version_unknown` are the only reachable
 *                           verdicts and NEITHER is evidence that the prior
 *                           work still stands. Confirm from the artifact.
 *  `no_rows`                nothing to grade.
 *
 *  Carried because the verdict alone cannot express it, and a caller that
 *  cannot tell "I checked and your work is current" from "I have no way to
 *  check" will act on the first when it was handed the second. */
export type VersionBasis =
  | 'recorded'
  | 'absent_on_these_rows'
  | 'unavailable_for_connector'
  | 'no_rows';

export interface PriorActionAnswer {
  target: string;
  verdict: PriorActionVerdict;
  actions: Array<{ actionType: string; connector: string; version: string | null; at: string }>;
  windowDays: number;
  scope: 'agent' | 'tenant';
  /** What this answer is blind to. Always carries `sandbox_shell`: the ledger
   *  records connector dispatch and nothing an agent typed into a shell, so
   *  EVERY answer here has that gap — including the affirmative ones, where it
   *  means the listed actions may be an undercount. Unconditional on purpose;
   *  a blind spot that is only reported sometimes is one a reader learns to
   *  ignore. */
  unobserved: UnobservedSurface[];
  /** Whether a revision comparison was possible at all. See VersionBasis. */
  versionBasis: VersionBasis;
}
