// HITL expiry — fires 24h after createHitlPause armed the timer.
//
// Called by the Cloud Tasks dispatcher when `workflowResume.kind ===
// 'hitl-expiry'`. Idempotent: if the operator already approved/rejected
// before the timer fired, this finds the row already `fired_at != null`
// and short-circuits cleanly; if the row is still pending, it marks the
// approval expired + audit-logs + emits SSE.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { insertAuditLog } from '../audit';
import { streamingService } from '../streaming';

export async function finalizeHitlExpired(input: {
  tenantId: string;
  agentId: string;
  invocationId: string;
  scheduledInvocationId: string;
}): Promise<{ expired: boolean; reason?: string }> {
  const { tenantId, agentId, invocationId, scheduledInvocationId } = input;
  const pool = getPoolForService('scheduled-execution');

  const rowRes = await pool.query(
    `SELECT workflow_resume_payload, fired_at, thread_id
     FROM agent_scheduled_invocations
     WHERE id = $1`,
    [scheduledInvocationId],
  );
  if (rowRes.rows.length === 0) {
    return { expired: false, reason: 'row_not_found' };
  }
  // Operator approved/rejected first — resume task already finalized.
  if (rowRes.rows[0].fired_at !== null) {
    logger.info({ scheduledInvocationId }, 'finalizeHitlExpired: row already fired, no-op');
    return { expired: false, reason: 'already_fired' };
  }

  const payload = rowRes.rows[0].workflow_resume_payload as {
    hitlContext?: { approvalId?: string; pendingToolCalls?: Array<{ name: string; input: Record<string, unknown> }> };
  };
  const approvalId = payload?.hitlContext?.approvalId;
  const pendingToolCalls = payload?.hitlContext?.pendingToolCalls ?? [];
  const threadId = (rowRes.rows[0].thread_id ?? null) as string | null;

  // Recovery backstop: if the operator actually DECIDED before this expiry
  // fired but the resume task was never delivered (e.g. a transient enqueue
  // failure in resolveApprovalAndResume), do NOT expire — signal the caller to
  // route this back through resumeFromHitlApproval so the decision is honoured
  // (approved → dispatch, rejected → continue-and-adapt). Nothing is mutated
  // here, so the subsequent resume sees the row still pending + unfired.
  // What, if anything, this approval ever told a human. An expiry where the
  // announcement reached nobody is not the same event as one a person saw and
  // declined to act on, and until migration 366 the record could not tell them
  // apart — it wrote '24h expiry — no operator decision' for both.
  let announcement = { attempted: false, delivered: 0, targets: 0 };
  if (approvalId) {
    const decRes = await pool.query<{
      decision: string | null;
      notify_attempted_at: Date | null;
      notify_delivered_count: number | null;
      notify_target_count: number | null;
    }>(
      `SELECT decision, notify_attempted_at, notify_delivered_count, notify_target_count
         FROM hitl_approval_requests WHERE id = $1`,
      [approvalId],
    );
    const decision = decRes.rows[0]?.decision ?? null;
    announcement = {
      attempted: decRes.rows[0]?.notify_attempted_at != null,
      delivered: decRes.rows[0]?.notify_delivered_count ?? 0,
      targets: decRes.rows[0]?.notify_target_count ?? 0,
    };
    if (decision === 'approved' || decision === 'rejected') {
      logger.warn({ scheduledInvocationId, approvalId, decision },
        'finalizeHitlExpired: approval was decided but never resumed — recovering via resume instead of expiring');
      return { expired: false, reason: 'decided_pending_resume' };
    }
  }

  // Mark scheduled row fired + approval row expired (best effort —
  // approval-row mutation is not transactional with the scheduled-row
  // update because they live in different services' tables; the worst
  // case is the scheduled row says fired but the approval still reads
  // pending. The hitl-expiry resume route is the only writer that
  // expires approvals; idempotent on duplicate delivery).
  await pool.query(
    `UPDATE agent_scheduled_invocations
     SET status = 'fired', fired_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'resume_inflight')`,
    [scheduledInvocationId],
  );
  if (approvalId) {
    try {
      await pool.query(
        `UPDATE hitl_approval_requests
         SET status = 'expired', updated_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [approvalId],
      );
    } catch (e) {
      logger.warn('finalizeHitlExpired: approval row update failed', {
        scheduledInvocationId, approvalId, error: (e as Error).message,
      });
    }
  }

  for (const tc of pendingToolCalls) {
    await insertAuditLog(null, tenantId, {
      internalAgentId: agentId,
      threadId: threadId ?? undefined,
      invocationId,
      action: tc.name,
      inputArgs: tc.input,
      // audit `outcome` enum is 'success'|'error'|'gated' (audit/types.ts:15);
      // expiry is a failure mode → 'error' with the reason carried in
      // logger.info above + the approval-row.status='expired' for the
      // structured query path.
      outcome: 'error',
      triggeredBy: 'system',
    });
  }

  if (threadId && approvalId) {
    streamingService.emitHitlRejected(
      threadId, invocationId, approvalId,
      announcement.attempted && announcement.delivered === 0
        ? '24h expiry — nobody was successfully notified of this approval'
        : '24h expiry — no operator decision',
    );
  }

  // Durable MCP HITL (Option 1) backstop. If an MCP-initiated chat run paused on
  // this approval it is still 'waiting_on_human', and — with waiting_on_human now
  // in the one-active-run-per-thread index — it is BLOCKING the thread. The
  // approval expired undecided, so settle the run as 'failed' (error_code
  // 'approval_expired') to free the thread and stop the client polling
  // waiting_on_human forever. Best-effort + idempotent (PB keys on approvalId +
  // the waiting_on_human guard); no-ops for web / Slack / Teams-origin approvals.
  if (approvalId) {
    try {
      const { settleMcpChatRunViaCallback } = await import('../platform-callback/client');
      // agentId here is the RUNTIME id; PB resolves the Teams card's display
      // name from internal_agents, which needs the control-plane id
      // (INV-TR-010).
      const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
      const internalAgentId = await resolveInternalAgentId(tenantId, agentId, 'hitl-expiry-settle');
      await settleMcpChatRunViaCallback({ tenantId, approvalId, agentId, internalAgentId, outcome: 'failed', threadId: threadId ?? undefined, errorCode: 'approval_expired' });
    } catch (e) {
      logger.warn('finalizeHitlExpired: MCP run settle-failed callback failed', {
        approvalId, error: (e as Error).message,
      });
    }
  }

  // Free the agent. Without this the agent is left in WAITING_FOR_HUMAN
  // forever after the approval lapses — the workflow leaks and the agent
  // never picks up new work (the root cause of the stuck-pending HITL
  // pile-up). decision stays NULL on the approval row so the operator can
  // still submit late feedback (would_approve/would_reject) for agent
  // learning — expiry is a timeout, NOT an auto-rejection. IDLE is the
  // terminal runtime status the sweeper uses for the same situation and is
  // always permitted (agent-lifecycle/service.ts updateRuntimeStatus).
  try {
    const { AgentLifecycleService } = await import('../agent-lifecycle/service');
    await new AgentLifecycleService().updateRuntimeStatus(agentId, 'IDLE');
  } catch (e) {
    logger.warn('finalizeHitlExpired: failed to free agent to IDLE', {
      agentId, scheduledInvocationId, error: (e as Error).message,
    });
  }

  // Two different events, and the log line says which. An approval that reached
  // nobody did not expire because a person declined to act — it expired because
  // the announcement failed and the gate then blamed them for the silence.
  if (announcement.attempted && announcement.delivered === 0) {
    logger.warn('HITL approval expired and NOBODY was ever notified — agent freed', {
      scheduledInvocationId, approvalId, agentId, tenantId, invocationId,
      intended_recipients: announcement.targets,
    });
  } else {
    logger.info('HITL approval expired without operator decision — agent freed', {
      scheduledInvocationId, approvalId, agentId, tenantId, invocationId,
      notified_recipients: announcement.delivered,
    });
  }

  return { expired: true };
}
