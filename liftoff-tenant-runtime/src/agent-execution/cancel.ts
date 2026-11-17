// Workflow cancel propagates to pending delay-step resumes.
//
// When a workflow is cancelled, any pending agent_scheduled_invocations rows
// for that workflow (contextRef = '{workflowId}:{stepId}') must be cancelled:
//   1. Bulk flip status='cancelled' via the repo (single round-trip).
//   2. Best-effort cancel each pending Cloud Task.
// A late-arriving resume/expiry fire is already a no-op: every resume handler
// guards on status IN ('pending','resume_inflight'), and the bulk flip moved
// these rows to 'cancelled'.

import { cancelScheduledAgentExecution } from '../infrastructure/cloud-tasks';
import { agentScheduledInvocationsRepo } from '../scheduling/agent-scheduled-invocations-repo';
import { logger } from '../infrastructure/logging';

export async function cancelWorkflow(tenantId: string, workflowId: string): Promise<void> {
  // 1. Atomic bulk flip — returns the cancelled rows so we can drive the
  //    Cloud Task delete + session delete passes without a re-query.
  const cancelled = await agentScheduledInvocationsRepo.cancelByContextRefPrefix(
    tenantId,
    `${workflowId}:`,
  );

  for (const row of cancelled) {
    // 2. Cancel the pending Cloud Task (best effort)
    try {
      await cancelScheduledAgentExecution(tenantId, row.agentId, row.scheduleKey, row.contextRef);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 5) {
        logger.warn(
          { err: (err as Error).message, task: row.cloudTaskName },
          'cancelScheduledAgentExecution failed (non-fatal)',
        );
      }
    }
  }

  logger.info(
    { tenantId, workflowId, cancelled: cancelled.length },
    'cancelWorkflow finished',
  );
}
