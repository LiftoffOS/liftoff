// Unified HITL decision → resume orchestration.
//
// Both decision entrypoints funnel through this one function so they behave
// identically:
//   - the Connect-RPC `resolveApproval` handler (rpc/tenant-runtime-service.ts)
//     — the path Platform Backend's /review page actually calls, and
//   - the REST approval router (hitl-enforcement/router.ts) — the original
//     path, still reachable for service-to-service callers.
//
// Before this unification the two paths had diverged: the REST router enqueued
// the resume Cloud Task (so the paused run dispatched), but the RPC handler
// only recorded the decision and stopped — so an operator-approved run paused
// via createHitlPause was never dispatched; it sat until the 24h expiry
// finalized it as expired. This function is the single place that:
//   1. records the decision (hitl_approval_requests + always-approve policy),
//   2. settles sandbox-code approvals server-side (no agent run to resume),
//   3. appends the decision to the typed run transcript (agent_run_states.items),
//   4. enqueues the resume task that dispatches approved calls / drives the
//      rejection's continue-and-adapt re-entry.

import { hitlEnforcementService } from './service';
import { agentRunStateService } from '../agent-execution/run-state/service';
import { enqueueResumeForHitl } from '../scheduling/hitl-resume-helpers';
import { log } from '../infrastructure/logging';
import type { HitlApprovalRequest } from './types';
import type { ApprovedEdits } from './approved-edits';

export interface ResolveAndResumeInput {
  approvalId: string;
  tenantId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedByRole: string;
  rejectionReason?: string;
  /** Why the approver said yes. Optional, and only read on an approval — the
   *  rejection half has carried `rejectionReason` since the beginning. */
  approvalNote?: string;
  /** Tool inputs the approver rewrote, keyed by pending tool call id. Read only
   *  on an approval: there is nothing to dispatch on a rejection, so an edit
   *  arriving with one is silently irrelevant rather than an error. */
  editedToolInputs?: ApprovedEdits;
  alwaysApply?: boolean;
}

/**
 * Record an operator's HITL decision and drive the paused run forward.
 *
 * Throws if the decision itself cannot be recorded (approval not found /
 * already decided / expired / tamper) — callers map those to 4xx. Post-decision
 * side effects (sandbox settle, transcript append, resume enqueue) are
 * best-effort and never throw, so a recorded decision always returns the
 * approval row.
 */
export async function resolveApprovalAndResume(
  input: ResolveAndResumeInput,
): Promise<HitlApprovalRequest> {
  const { approvalId, tenantId, decision, decidedBy, decidedByRole, rejectionReason, approvalNote, editedToolInputs, alwaysApply } = input;

  // 1. Record the decision. approveRequest / rejectRequest update the row,
  //    persist the always-approve policy when requested, and (on reject) fire
  //    correction-capture + reflection. These throw on invalid state.
  const approval = decision === 'approved'
    ? await hitlEnforcementService.approveRequest({ approvalId, decision: 'approved', decidedBy, decidedByRole, alwaysApply, approvalNote, editedToolInputs })
    : await hitlEnforcementService.rejectRequest({ approvalId, decision: 'rejected', decidedBy, decidedByRole, rejectionReason, alwaysApply });

  // 2. Sandbox-code approvals have no paused agent run to resume — the blocked
  //    script polls /mcp/await-approval. Execute (approve) or settle (reject)
  //    server-side and return.
  if (approval.source === 'sandbox_code') {
    try {
      const { executeSandboxApprovedCall, rejectSandboxApprovedCall } = await import('../internal-api/sandbox-approval-executor');
      if (decision === 'approved') await executeSandboxApprovedCall(approval);
      else await rejectSandboxApprovedCall(approval, rejectionReason ?? 'rejected');
    } catch (err) {
      log.error({ err: (err as Error).message, approvalId }, 'Failed to settle sandbox-code approval server-side');
    }
    return approval;
  }

  // 3. Drive the paused run forward. Everything past the committed decision is
  //    best-effort: a transient failure here must NOT throw, because the
  //    decision is already recorded and re-calling approve/rejectRequest would
  //    throw "already decided" — leaving the operator unable to retry. If the
  //    resume enqueue is missed, the 24h expiry task recovers it (it routes a
  //    decided-but-unfired pause back through resumeFromHitlApproval rather than
  //    expiring it).
  try {
    // 3a. Locate the paused row. createHitlPause armed a 24h expiry row whose
    //     hitlContext carries this approvalId. No row → interactive chat /
    //     external-agent synchronous flow that never paused; nothing to resume.
    const pauseRow = await hitlEnforcementService.findHitlPauseForApproval(approvalId, tenantId);
    if (!pauseRow) {
      log.info({ approvalId },
        'HITL decision recorded but no hitl_approval pause row — interactive chat / external agent (no resume needed)');
      return approval;
    }

    // 3b. Record the decision in the typed run transcript (agent_run_states.items)
    //     so a2a handoff context, diagnostics/RCA, and the /review timeline show
    //     it — one item per gated tool call. The AgentRunItem union carries a
    //     dedicated `hitl_approval` variant for exactly this.
    const invocationId = pauseRow.scheduledByInvocationId;
    const pendingToolCalls = approval.pendingToolCalls ?? [];
    if (invocationId && pendingToolCalls.length > 0) {
      const runState = await agentRunStateService.load(invocationId).catch(() => null);
      const turn = runState?.currentTurn ?? 0;
      const timestamp = new Date().toISOString();
      for (const tc of pendingToolCalls) {
        await agentRunStateService.appendItem(invocationId, {
          type: 'hitl_approval',
          callId: tc.id,
          toolName: tc.name,
          decision,
          decidedBy,
          turn,
          timestamp,
        }).catch(() => undefined);
      }
    }

    // 3c. Enqueue the resume task. For 'approved' this dispatches the
    //     operator-authorised tool calls and continues the loop; for 'rejected'
    //     it injects the rejection as a tool_result error and re-enters so the
    //     agent can adapt (bounded by recovery caps; re-proposed consequential
    //     actions re-gate). This is the step the RPC path was missing.
    await enqueueResumeForHitl({
      tenantId,
      agentId: pauseRow.agentId,
      threadId: pauseRow.threadId ?? '',
      scheduledRowId: pauseRow.id,
      scheduledByInvocationId: invocationId ?? '',
      kind: decision === 'approved' ? 'hitl-approved' : 'hitl-rejected',
    });
  } catch (err) {
    // Decision is committed; the 24h expiry backstop recovers a missed resume.
    log.error({ err: (err as Error).message, approvalId },
      'HITL decision recorded but resume orchestration failed — expiry backstop will recover');
  }

  return approval;
}
