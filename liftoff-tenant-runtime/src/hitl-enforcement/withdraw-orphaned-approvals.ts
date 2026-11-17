// A question can outlive the work it was about.
//
// The gate fires, an approval row is created, the agent pauses — and then the
// run ends anyway. A step took its `onFailure` branch, or the run errored, or it
// escalated. The approval stays `pending` in the queue, but answering it can no
// longer do anything: there is no paused run left to release, and no action left
// to authorise or refuse.
//
// For example: a gated tool call logs 'HITL gate triggered, execution paused',
// then the loop routes to the step's failure handler and the invocation
// completes 'success' seconds later with a pending approval still outstanding.
// The operator's approval requirement never held the work, and the approval is
// left pending forever against a finished run, so deciding it can change
// nothing.
//
// Left alone, it sits until the expiry sweeper flips it to `expired`, which
// files "Pause expired without resolution" and reads as a person who ignored a
// question. That is a false record about somebody, produced by a question that
// had stopped mattering hours earlier.
//
// WHAT MAKES THIS PROVABLE
//
// `invocations.outcome` distinguishes the two states exactly. 'gated' means
// oversight blocked or paused the run — the approval is LIVE and must not be
// touched. Any other terminal outcome means the run finished without it.
// Migration 329 added 'gated' for precisely this reason: a governance stop used
// to record 'success', so a blocked run was indistinguishable from a completed
// one, and "did the run end without its approval" was unanswerable.
//
// So the rule reads off two columns and needs no simulation, no re-evaluation of
// policy, and no judgement about whether the gate was RIGHT. It is not "this
// question was wrong"; it is "this question can no longer have an answer".
//
// WHY THE SYSTEM AND NEVER AN OPERATOR
//
// A queue whose items can be dismissed rather than decided means less than one
// whose items must be decided. `WITHDRAWN_BY_SYSTEM` goes in `decided_by` so the
// audit trail names something that is plainly not a person — recording a human
// on a withdrawal would recreate the exact falsehood the status exists to
// remove.
//
// A withdrawal is NOT a decision. `decision` stays NULL, and the column's own
// CHECK still allows only approved | rejected. Nobody decided anything.
//
// NO RESUME IS NEEDED HERE, and that is a property of this rule rather than a
// gap. The general trap — withdrawing while a run is still parked, so it hits
// its expiry and writes the same false line a few hours later — cannot apply,
// because this rule only ever matches approvals whose run has ALREADY reached a
// terminal outcome. There is nothing left to release.

import { stagedBatchRepository } from '../tool-gateway/staged-batches';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { insertAuditLog } from '../audit';
import { WITHDRAWN_BY_SYSTEM } from './types';

export interface WithdrawnApproval {
  id: string;
  tenantId: string;
  agentId: string;
  reason: string;
  invocationOutcome: string;
}

/**
 * Close approvals whose run has already finished.
 *
 * Returns what it withdrew so the caller can log a count; the per-row audit is
 * written here so no caller can forget it.
 */
export async function withdrawOrphanedApprovals(limit = 100): Promise<WithdrawnApproval[]> {
  // One statement. Selecting and then updating would race the operator: a person
  // deciding between the two would have their decision overwritten by a
  // withdrawal, which is the one outcome worse than the false expiry this
  // prevents. `status = 'pending'` inside the UPDATE is the guard.
  const res = await pool.query<{
    id: string;
    tenant_id: string;
    agent_id: string;
    reason: string;
    outcome: string;
  }>(
    `UPDATE hitl_approval_requests a
        SET status = 'withdrawn',
            decided_by = $1,
            decided_at = NOW(),
            updated_at = NOW(),
            context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
              'withdrawnReason', 'the run this question was raised for ended without it',
              'invocationOutcome', i.outcome
            )
       FROM invocations i
      WHERE a.invocation_id = i.id
        AND a.status = 'pending'
        AND i.outcome IS NOT NULL
        -- 'gated' means the run is PAUSED on this very approval. Touching one of
        -- those would close a live question and strand the run.
        AND i.outcome <> 'gated'
        AND a.id IN (
          SELECT a2.id
            FROM hitl_approval_requests a2
            JOIN invocations i2 ON i2.id = a2.invocation_id
           WHERE a2.status = 'pending'
             AND i2.outcome IS NOT NULL
             AND i2.outcome <> 'gated'
           LIMIT $2
        )
      RETURNING a.id, a.tenant_id, a.agent_id, a.reason, i.outcome, a.invocation_id`,
    [WITHDRAWN_BY_SYSTEM, limit],
  );

  const withdrawn: WithdrawnApproval[] = res.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    reason: r.reason,
    invocationOutcome: r.outcome,
  }));

  // A withdrawn run's staged batches go with it (ADR-052 rule 5, clause 4): a
  // draft nobody will ever be asked about must not stay applicable.
  for (const r of res.rows as Array<{ tenant_id: string; invocation_id?: string | null }>) {
    if (!r.invocation_id) continue;
    await stagedBatchRepository()
      .cancelForInvocation(r.tenant_id, r.invocation_id, 'the run that staged this batch ended without applying it')
      .catch((err: Error) => log.warn({ err: err.message, invocationId: r.invocation_id }, 'Non-fatal: staged batches not cancelled with the withdrawn run'));
  }

  for (const w of withdrawn) {
    log.info(
      {
        event: 'hitl_approval_withdrawn',
        metric: 'hitl.approval.withdrawn',
        approval_id: w.id,
        gate_reason: w.reason,
        invocation_outcome: w.invocationOutcome,
        tenant_id: w.tenantId,
        agent_id: w.agentId,
      },
      'approval withdrawn — the run it was raised for ended without it, so no decision could change anything',
    );
    // Audited per row. A status that exists to make the record honest has to
    // leave a record of its own.
    await insertAuditLog(null, w.tenantId, {
      internalAgentId: w.agentId,
      action: 'hitl_approval_withdrawn',
      inputArgs: {
        approvalId: w.id,
        gateReason: w.reason,
        invocationOutcome: w.invocationOutcome,
      },
      outcome: 'success',
      triggeredBy: WITHDRAWN_BY_SYSTEM,
    }).catch(() => undefined);
  }

  return withdrawn;
}
