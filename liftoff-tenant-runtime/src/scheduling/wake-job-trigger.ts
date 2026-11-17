// Self-wake job triggers. When an invocation reaches a terminal state, fire any
// wake_on_job whose spec.childInvocationId is that invocation — enqueuing a wake-job resume Cloud
// Task. Fire-and-forget from invocationsService.completeInvocation (must never crash it).

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export async function fireWakeOnJobForCompletedInvocation(
  childInvocationId: string,
  tenantId: string,
  outcome: string,
  childTrust?: 'trusted' | 'untrusted_inbound',
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, agent_id, thread_id, scheduled_by_invocation_id
     FROM agent_scheduled_invocations
     WHERE tenant_id = $1 AND wake_kind = 'job' AND status = 'pending'
       AND wake_spec->>'childInvocationId' = $2`,
    [tenantId, childInvocationId],
  );
  if (rows.length === 0) return;

  // J1 — who did the work, and what went wrong if anything did. Without this
  // the parent resumes knowing only an opaque invocation id and the word
  // 'error', which is strictly less than it knew when it delegated. The child's
  // own OBJECTIVE is deliberately not persisted for delegated runs (migration
  // 306, data minimization), so the parent's wake note stays the record of what
  // it asked for; this adds what only the child can tell it.
  let child: { agentName: string | null; errorMessage: string | null } = { agentName: null, errorMessage: null };
  try {
    const c = await pool.query<{ agent_name: string | null; error_message: string | null }>(
      `SELECT a.name AS agent_name, i.error_message
         FROM invocations i
         LEFT JOIN agents a ON a.id = i.agent_id
        WHERE i.id = $1 AND i.tenant_id = $2`,
      [childInvocationId, tenantId],
    );
    if (c.rows[0]) {
      child = {
        agentName: c.rows[0].agent_name,
        // Bounded: this lands inside the untrusted-payload frame of the wake
        // message, not in a log.
        errorMessage: c.rows[0].error_message ? c.rows[0].error_message.slice(0, 500) : null,
      };
    }
  } catch (err) {
    // The wake must fire either way; richer context is a bonus, not a gate.
    logger.warn(
      { childInvocationId, error: (err as Error).message },
      'wake_on_job: child detail lookup failed (firing with the outcome alone)',
    );
  }

  const { enqueueAgentExecution } = await import('../infrastructure/cloud-tasks');
  for (const row of rows) {
    await enqueueAgentExecution(tenantId, row.agent_id as string, {
      objective: 'wake-job',
      threadId: (row.thread_id as string) ?? '',
      triggeredBy: 'agent', triggeredByLabel: `wake-job:${row.id}`,
      scheduleKey: new Date().toISOString().slice(0, 16),
      contextRef: `wake-job:${row.id}`,
      receiverPath: '/api/tasks/resume-execution',
      receiverBody: {
        tenantId, agentId: row.agent_id,
        invocationId: row.scheduled_by_invocation_id,
        workflowResume: {
          scheduledInvocationId: row.id, kind: 'wake-job',
          // childTrust lets the resume inherit the child run's ACTUAL trust; absent → untrusted.
          wakePayload: {
            jobResult: {
              childInvocationId,
              outcome,
              // Named, so the parent's reply can say who reported back rather
              // than quoting a uuid at the person reading it.
              ...(child.agentName ? { agentName: child.agentName } : {}),
              ...(child.errorMessage ? { error: child.errorMessage } : {}),
            },
            childTrust: childTrust ?? null,
          },
        },
      },
    } as Parameters<typeof enqueueAgentExecution>[2]).catch((err) =>
      logger.warn('wake-job enqueue failed', { wakeId: row.id, error: (err as Error).message }));
  }
  logger.info('Fired wake_on_job for completed invocation', { childInvocationId, count: rows.length });
}
