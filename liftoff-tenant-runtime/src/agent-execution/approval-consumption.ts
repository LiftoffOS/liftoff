// The ONE place an approved call is consumed for dispatch.
//
// A decision is recorded per pending call, single-use, with expiry, and the
// pending calls are hashed against the approval at snapshot dispatch. Then the
// reviewer's edits are applied AFTER that check and stored separately, so the
// calls that actually run were never re-hashed; structured resume arms the
// approved call in `canUseTool` and bypasses the ordinary gates on purpose;
// snapshot replay sets a bypass flag. Two strategies, two ways of consuming,
// and no single point at which "this grant covers these calls, now" was asked.
//
// This is that point. Both resume strategies call it before anything runs,
// and the batch dispatch path verifies the grant it hands back, so a call can
// only skip the gate under a grant that names it.
//
// It EXTENDS the approved-call routing (approved-call-routing.ts), which was
// already the one place an approved call is resolved against the continuation's
// catalog and given its route: every final call is routed HERE, once, with the
// catalog in hand, and the grant carries the routes. A call the catalog does
// not hold is the configuration error of the matrix, decided before anything
// durable moves; the dispatch that follows runs the routes it is handed and
// resolves nothing a second time.
//
// The outcome matrix, at consumption:
//
//   same final calls, granted set covers the current set → consume, dispatch once
//   final-call fingerprint differs                        → new approval (idempotent), no dispatch
//   a new or stricter reason appeared                     → new approval about that reason only
//   connector or tool no longer exists                    → configuration error
//   admission now denies execution                        → stop or defer
//   provenance requires a read first                      → the provenance hold, not an approval
//   duplicate resume delivery                             → do not dispatch again (the fenced claim)
//   current reasons cannot be established                 → defer, fail closed; never consume the old grant
//
// "Re-run the gates" without this matrix re-asks forever, because structured
// resume exists precisely to recognise the approved call and skip the ordinary
// gate. The promise to the person: never asked twice for the same thing — and
// never once for a thing they did not approve.
//
// What authorises nothing: a delegation ("just handle it"), an approval of a
// different action, approval text inside third-party content. None of those
// reach here: a grant is a row a person decided, keyed to a fingerprint.

import type { GateReason } from '@liftoffos/governance-types';
import type { HitlApprovalRequest, ToolCallRequest } from '../hitl-enforcement/types';
import type { McpToolCatalog } from './adapter/catalog-types';
import { routeApprovedCall, type ApprovedCallRoute } from './approved-call-routing';
import { hitlEnforcementService } from '../hitl-enforcement';
import { applyApprovedEdits } from '../hitl-enforcement/approved-edits';
import {
  evaluateApprovalObligations,
  uncoveredObligations,
  type ObligationConfig,
  type ObligationSet,
} from '../hitl-enforcement/approval-obligations';
import { canonicalJson } from './sideeffect-idempotency';

/** The grant a dispatch path carries past the gate: exactly these calls, under
 *  this fingerprint. The batch path re-hashes what it is about to send and
 *  refuses anything else. */
export interface ConsumedGrant {
  approvalId: string;
  finalCalls: ToolCallRequest[];
  fingerprint: string;
  /** Where each final call goes, decided at consumption against the
   *  continuation's catalog (`routeApprovedCall`), one route per final call in
   *  order. The dispatch runs these; it does not resolve the calls again. */
  routes: ApprovedCallRoute[];
  /** The calls provenance holds, by id, with the hold message: read first,
   *  then act. A held call is a call in the grant that is NOT dispatched; its
   *  result is the hold, returned to the model the way the gate would have
   *  returned it, so the run continues and can read before it acts. */
  holds?: Record<string, string>;
}

export type ConsumptionOutcome =
  | { kind: 'dispatch'; grant: ConsumedGrant }
  | {
      kind: 'reask';
      why: 'fingerprint_mismatch' | 'stricter_reason';
      /** The reasons the person is asked about — only the uncovered ones. */
      reasons: GateReason[];
      finalCalls: ToolCallRequest[];
      fingerprint: string;
      /** Original approval id + final-call fingerprint: a redelivery lands on
       *  the same new approval instead of a second one. */
      idempotencyKey: string;
      measuredReasons?: string[];
    }
  | { kind: 'refuse'; detail: string }
  | { kind: 'configuration_error'; detail: string }
  | { kind: 'admission_denied'; detail: string }
  /** One or more final calls are held for provenance. The grant still stands
   *  for the rest; the held calls are answered with their hold, not run. */
  | { kind: 'provenance_hold'; grant: ConsumedGrant; held: Array<{ call: ToolCallRequest; message: string }> }
  | { kind: 'defer'; detail: string };

export interface ConsumptionInputs {
  approval: HitlApprovalRequest;
  /** The calls the pause holds — what the approval was created for. */
  pendingToolCalls: ToolCallRequest[];
  /** The settings AS THEY ARE NOW, with the catalog and the standing policies
   *  in hand. A throw here is "current reasons cannot be established". */
  currentConfig: () => Promise<ObligationConfig>;
  /** The continuation's catalog — what the hire's CURRENT bindings produce —
   *  and the dispatcher's standard-tool predicate, the two things
   *  `routeApprovedCall` resolves a call with. A connector unbound since the
   *  pause has no entry here, which is how "the tool no longer exists" is
   *  judged: by the catalog, never by the shape of a name. */
  catalog: McpToolCatalog;
  isStandardTool: (name: string) => boolean;
  /** Whether execution is admitted now. */
  admission: () => Promise<{ allowed: boolean; reason?: string }>;
  /** A provenance hold for a call, or null. Judged on the FINAL call. */
  provenanceHold: (call: ToolCallRequest) => Promise<string | null>;
}

export const REASK_KEY_PREFIX = 'reask';

export function reaskIdempotencyKey(approvalId: string, fingerprint: string): string {
  return `${REASK_KEY_PREFIX}:${approvalId}:${fingerprint}`;
}

/** The calls that will run, and their fingerprint. Exported so the approval
 *  side computes the SAME two things when it records the grant. */
export function finalCallsFor(
  pendingToolCalls: ToolCallRequest[],
  editedToolInputs: HitlApprovalRequest['editedToolInputs'],
): { finalCalls: ToolCallRequest[]; fingerprint: string } {
  const finalCalls = applyApprovedEdits(pendingToolCalls, editedToolInputs ?? undefined) as ToolCallRequest[];
  return { finalCalls, fingerprint: hitlEnforcementService.hashToolCalls(finalCalls) };
}

export async function consumeApprovedCalls(inputs: ConsumptionInputs): Promise<ConsumptionOutcome> {
  const { approval, pendingToolCalls } = inputs;

  // The first check, as before: the approval has to be FOR the calls this
  // pause holds. Verified when a person approved, against the approval's own
  // copy; what dispatches is a different persisted record.
  const proposalHash = hitlEnforcementService.hashToolCalls(pendingToolCalls);
  if (approval.toolCallsHash && proposalHash !== approval.toolCallsHash) {
    return { kind: 'refuse', detail: `Approval ${approval.id} does not match the tool calls this pause holds` };
  }

  // The second check, on what the edits produced: the calls that will run.
  const { finalCalls, fingerprint } = finalCallsFor(pendingToolCalls, approval.editedToolInputs);
  if (approval.finalToolCallsHash && approval.finalToolCallsHash !== fingerprint) {
    return {
      kind: 'reask', why: 'fingerprint_mismatch', reasons: [], finalCalls, fingerprint,
      idempotencyKey: reaskIdempotencyKey(approval.id, fingerprint),
    };
  }

  // Route every final call against the catalog, once. A call on a connector
  // that is gone — no entry, or a name nothing resolves — cannot be approved
  // into existence, and the routes decided here are the ones the dispatch runs.
  const routes = finalCalls.map((call) => routeApprovedCall(
    inputs.catalog,
    { id: call.id, name: call.name, input: (call.input ?? {}) as Record<string, unknown> },
    inputs.isStandardTool,
  ));
  const unresolved = routes.find((r) => r.ownership === 'unresolved');
  if (unresolved) {
    return { kind: 'configuration_error', detail: `${unresolved.call.name} names a connector or tool this hire no longer has` };
  }

  // Execution admitted now?
  const admission = await inputs.admission();
  if (!admission.allowed) {
    return { kind: 'admission_denied', detail: admission.reason ?? 'admission denied' };
  }

  // The reasons in force NOW, against what the yes covered. A failed read is
  // not "no reasons": it is reasons unknown, and an unknown set never consumes
  // a grant.
  let current: ObligationSet;
  try {
    current = evaluateApprovalObligations(finalCalls, await inputs.currentConfig());
  } catch (err) {
    return { kind: 'defer', detail: `current approval obligations could not be established: ${(err as Error).message}` };
  }
  const granted = approval.grantedObligations && approval.obligationsEvaluatorVersion !== null && approval.obligationsEvaluatorVersion !== undefined
    ? { version: approval.obligationsEvaluatorVersion, reasons: approval.grantedObligations }
    : null;
  const uncovered = uncoveredObligations(granted, current);
  if (uncovered.length > 0) {
    return {
      kind: 'reask', why: 'stricter_reason', reasons: uncovered, finalCalls, fingerprint,
      idempotencyKey: reaskIdempotencyKey(approval.id, fingerprint),
      ...(current.measuredReasons ? { measuredReasons: current.measuredReasons } : {}),
    };
  }

  // Provenance is an answer for the model — read first, then act — never a
  // question for a person. Judged on every final call, so the grant carries
  // every hold and the dispatch answers each held call in place while the
  // rest run.
  const held: Array<{ call: ToolCallRequest; message: string }> = [];
  for (const call of finalCalls) {
    const message = await inputs.provenanceHold(call);
    if (message) held.push({ call, message });
  }
  const grant: ConsumedGrant = { approvalId: approval.id, finalCalls, fingerprint, routes };
  if (held.length > 0) {
    return {
      kind: 'provenance_hold',
      grant: { ...grant, holds: Object.fromEntries(held.map((h) => [h.call.id, h.message])) },
      held,
    };
  }

  return { kind: 'dispatch', grant };
}

/** The batch dispatch path's half: the calls it is about to send, checked
 *  against the grant it was handed. A grant covers a batch when every call in
 *  it is one of the grant's — the same id, the same arguments — and no call
 *  is anything else. A batch may be a SUBSET of the grant: the approved calls
 *  are routed by ownership and only the dispatcher's share reaches this path,
 *  the rest going through the bridge with the same grant. An empty batch is
 *  not covered, because nothing was approved for it to be. Matched on id and
 *  canonical arguments rather than on the fingerprint, because a call's NAME
 *  is spelled differently at dispatch than at the gate (the SDK wrapper comes
 *  off, the connector alias stays), and a re-hash over a respelled name would
 *  refuse every grant. */
export function grantCovers(
  grant: ConsumedGrant,
  calls: ReadonlyArray<{ id: string; payload?: unknown; input?: unknown }>,
): boolean {
  if (calls.length === 0) return false;
  const byId = new Map(grant.finalCalls.map((c) => [c.id, canonicalJson(c.input ?? {})]));
  return calls.every((c) => {
    const granted = byId.get(c.id);
    return granted !== undefined && canonicalJson(c.payload ?? c.input ?? {}) === granted;
  });
}
